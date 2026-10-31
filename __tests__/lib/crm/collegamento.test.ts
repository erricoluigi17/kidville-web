import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Riga, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * CRM della segreteria · Compito 4.1 — il collegamento fra le domande di iscrizione e le schede.
 *
 * Il database è il finto che APPLICA i filtri (`creaFintoSupabase`): «una scheda di un'altra sede non
 * si collega» è una proprietà provata, non asserita, perché il filtro `.eq('scuola_id')` toglie
 * davvero la riga. Il logger è finto per leggere cosa finisce nel registro: i dati di una famiglia
 * (nomi, telefoni, email) non devono mai comparirvi.
 *
 * Solo dati finti: «Famiglia Prova», 333 000 0001, prova@example.com, SEDE_A / SEDE_B.
 */

const h = vi.hoisted(() => ({
  log: [] as { evento: string; livello: string; campi: Record<string, unknown>; err: unknown }[],
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, err?: unknown) => {
      h.log.push({ evento, livello, campi, err })
    },
    logErrore: (campi: Record<string, unknown>, err?: unknown) => {
      h.log.push({ evento: 'errore', livello: 'error', campi, err })
    },
  }
})

import {
  abbinaFigli,
  collegaAMano,
  collegaDomandaAlCrm,
  estraiDaDomanda,
  scollega,
  segnalaDomandaRespinta,
  segnalaDomandeCancellate,
  type FiglioDomanda,
} from '@/lib/crm/collegamento'

const D1 = 'd1d1d1d1-0000-4000-8000-000000000001'
const D2 = 'd2d2d2d2-0000-4000-8000-000000000002'
const D3 = 'd3d3d3d3-0000-4000-8000-000000000003'
const S1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const S2 = 'a2a2a2a2-0000-4000-8000-000000000002'
const S3 = 'a3a3a3a3-0000-4000-8000-000000000003'
const B1 = 'b1b1b1b1-0000-4000-8000-000000000001'
const B2 = 'b2b2b2b2-0000-4000-8000-000000000002'
const B3 = 'b3b3b3b3-0000-4000-8000-000000000003'
const UTENTE = 'c1c1c1c1-0000-4000-8000-000000000001'

/** Un istante di `mesi` mesi fa: nessuna data cablata, il test non scade col calendario. */
function mesiFa(mesi: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - mesi)
  return d.toISOString()
}

/** I dati che NON devono mai finire in un log. */
const DATI_PERSONALI = ['Famiglia', 'Prova', 'Bimbo', 'Bimba', 'Gemello', '333', 'prova@example.com', '2024-03-05', '2022-07-09']

function figlioDomanda(nome: string, dataNascita: string | null) {
  return { nome, cognome: 'Prova', data_nascita: dataNascita, codice_fiscale: 'PRVBMB24C45H501X', allergies: 'testo libero' }
}
function adultoDomanda(extra: Record<string, unknown> = {}) {
  return { ruolo: 'mother', first_name: 'Famiglia', last_name: 'Prova', phone: '+39 333 000 0001', email: 'prova@example.com', ...extra }
}
function domanda(id: string, sede: string | null, figli: unknown[], adulti: unknown[], extra: Riga = {}): Riga {
  return { id, scuola_id: sede, status: 'pending', created_at: new Date().toISOString(), data: { children: figli, adults: adulti }, ...extra }
}
function scheda(id: string, sede: string, contatti: { tel?: string[]; email?: string[] }, extra: Riga = {}): Riga {
  return {
    id,
    scuola_id: sede,
    telefoni_norm: contatti.tel ?? [],
    email_norm: contatti.email ?? [],
    creata_il: new Date().toISOString(),
    domanda_da_associare: null,
    ...extra,
  }
}
function bambino(id: string, schedaId: string, sede: string, extra: Riga = {}): Riga {
  return {
    id,
    scheda_id: schedaId,
    scuola_id: sede,
    nome: 'Bimbo',
    data_nascita: '2024-03-05',
    esito: 'aperto',
    esito_origine: null,
    esito_da: null,
    esito_il: null,
    domanda_id: null,
    domanda_figlio: null,
    domanda_collegata_il: null,
    nota_collegamento: null,
    da_verificare: false,
    ...extra,
  }
}

function conDb(db: DBFinto, errori?: OpzioniFinto['errori']) {
  const scritture: Scrittura[] = []
  const client = creaFintoSupabase(db, [], { scritture, errori })
  return { client, scritture, db }
}
const aggiornamentiBambini = (s: Scrittura[]) => s.filter((x) => x.tabella === 'crm_bambini' && x.operazione === 'update')
const eventiScritti = (db: DBFinto) => (db.crm_eventi ?? []) as Riga[]

beforeEach(() => {
  h.log.length = 0
})
afterEach(() => {
  // Il registro non contiene mai i dati di una famiglia, in nessun test.
  const testo = JSON.stringify(h.log.map((r) => ({ evento: r.evento, livello: r.livello, campi: r.campi })))
  for (const dato of DATI_PERSONALI) expect(testo, `«${dato}» è finito in un log`).not.toContain(dato)
})

// ─────────────────────────────────────────────────────────────────────────────
// abbinaFigli — pura
// ─────────────────────────────────────────────────────────────────────────────

describe('abbinaFigli', () => {
  const figlio = (indice: number, nome: string | null, dataNascita: string | null): FiglioDomanda => ({
    indice,
    nome,
    cognome: 'Prova',
    dataNascita,
  })
  const b = (id: string, nome: string | null, data: string | null, domanda: string | null = null) => ({
    id,
    nome,
    data_nascita: data,
    domanda_id: domanda,
  })

  it('stessa data di nascita → una coppia, non ambiguo', () => {
    expect(abbinaFigli([b(B1, 'Bimbo', '2024-03-05')], [figlio(0, 'Altro', '2024-03-05')])).toEqual({
      coppie: [{ bambinoId: B1, figlio: 0 }],
      ambiguo: false,
    })
  })
  it('due bambini e due figli con date diverse → due coppie, anche in ordine inverso', () => {
    const r = abbinaFigli(
      [b(B1, 'Bimbo', '2024-03-05'), b(B2, 'Bimba', '2022-07-09')],
      [figlio(0, 'Bimba', '2022-07-09'), figlio(1, 'Bimbo', '2024-03-05')],
    )
    expect(r.ambiguo).toBe(false)
    expect(r.coppie).toEqual(
      expect.arrayContaining([
        { bambinoId: B1, figlio: 1 },
        { bambinoId: B2, figlio: 0 },
      ]),
    )
    expect(r.coppie).toHaveLength(2)
  })
  it('senza data: basta una parola di tre lettere in comune nel nome, senza badare a maiuscole e accenti', () => {
    expect(abbinaFigli([b(B1, 'GIÒ Maria', null)], [figlio(0, 'maria chiara', null)]).coppie).toEqual([
      { bambinoId: B1, figlio: 0 },
    ])
  })
  it('senza data: una parola di due lettere non basta', () => {
    const r = abbinaFigli([b(B1, 'Al', null)], [figlio(0, 'Al', null)])
    expect(r).toEqual({ coppie: [], ambiguo: true })
  })
  it('date diverse → non si abbinano nemmeno se il nome coincide', () => {
    const r = abbinaFigli([b(B1, 'Bimbo', '2024-03-05')], [figlio(0, 'Bimbo', '2023-01-01')])
    expect(r).toEqual({ coppie: [], ambiguo: true })
  })
  it('il cognome non abbina: due fratelli lo condividono', () => {
    // «Bimbo Prova» e «Bimba Prova»: il figlio «Bimba» non deve prendersi «Bimbo» per il cognome.
    const r = abbinaFigli(
      [b(B1, 'Bimbo Prova', null), b(B2, 'Bimba Prova', null)],
      [{ indice: 0, nome: 'Bimba', cognome: 'Prova', dataNascita: null }],
    )
    expect(r).toEqual({ coppie: [{ bambinoId: B2, figlio: 0 }], ambiguo: false })
  })
  it('due bambini senza data e un figlio che li abbina entrambi → ambiguo, nessuna coppia', () => {
    const r = abbinaFigli([b(B1, 'Maria Rosa', null), b(B2, 'Maria Luisa', null)], [figlio(0, 'Maria', null)])
    expect(r).toEqual({ coppie: [], ambiguo: true })
  })
  it('due bambini senza nome né data e un figlio → ambiguo (niente di certo)', () => {
    expect(abbinaFigli([b(B1, null, null), b(B2, null, null)], [figlio(0, 'Bimbo', null)])).toEqual({
      coppie: [],
      ambiguo: true,
    })
  })
  it('gemelli: stessa data, due bambini e due figli → ambiguo', () => {
    const r = abbinaFigli(
      [b(B1, 'Bimbo', '2024-03-05'), b(B2, 'Gemello', '2024-03-05')],
      [figlio(0, 'Bimbo', '2024-03-05'), figlio(1, 'Gemello', '2024-03-05')],
    )
    expect(r).toEqual({ coppie: [], ambiguo: true })
  })
  it('un conflitto rende ambigua TUTTA la domanda, anche il bambino che sarebbe certo', () => {
    const r = abbinaFigli(
      [b(B1, 'Bimbo', '2020-01-01'), b(B2, 'Gemello', '2024-03-05'), b(B3, 'Gemella', '2024-03-05')],
      [figlio(0, 'Bimbo', '2020-01-01'), figlio(1, 'Gemello', '2024-03-05')],
    )
    expect(r).toEqual({ coppie: [], ambiguo: true })
  })
  it('un bambino della scheda che nella domanda non c’è resta fuori e non rende ambigua la domanda', () => {
    const r = abbinaFigli(
      [b(B1, 'Bimbo', '2024-03-05'), b(B2, 'Bimba', '2022-07-09')],
      [figlio(0, 'Bimbo', '2024-03-05')],
    )
    expect(r).toEqual({ coppie: [{ bambinoId: B1, figlio: 0 }], ambiguo: false })
  })
  it('i bambini già collegati restano fuori', () => {
    const r = abbinaFigli(
      [b(B1, 'Bimbo', '2024-03-05', D2), b(B2, 'Bimba', '2022-07-09')],
      [figlio(0, 'Bimbo', '2024-03-05'), figlio(1, 'Bimba', '2022-07-09')],
    )
    expect(r).toEqual({ coppie: [{ bambinoId: B2, figlio: 1 }], ambiguo: false })
  })
  it('nessun figlio → ambiguo', () => {
    expect(abbinaFigli([b(B1, 'Bimbo', '2024-03-05')], [])).toEqual({ coppie: [], ambiguo: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// estraiDaDomanda — pura
// ─────────────────────────────────────────────────────────────────────────────

describe('estraiDaDomanda', () => {
  it('prende solo ciò che serve: figli (nome, cognome, data), contatti degli adulti, nome del genitore', () => {
    const e = estraiDaDomanda({
      children: [figlioDomanda('Bimbo', '2024-03-05'), figlioDomanda('Bimba', '05/04/2022')],
      adults: [adultoDomanda(), { ruolo: 'father', first_name: 'Altro', last_name: 'Genitore', phone: '0039 333-0000002', email: ' ALTRO@Example.COM ' }],
    })
    expect(e.figli).toEqual([
      { indice: 0, nome: 'Bimbo', cognome: 'Prova', dataNascita: '2024-03-05' },
      { indice: 1, nome: 'Bimba', cognome: 'Prova', dataNascita: '2022-04-05' },
    ])
    expect(e.telefoni).toEqual(['+39 333 000 0001', '0039 333-0000002'])
    expect(e.email).toEqual(['prova@example.com', ' ALTRO@Example.COM '])
    expect(e.genitore).toBe('Famiglia Prova')
    // Nessun altro campo della domanda esce da qui (codice fiscale, allergie…).
    expect(JSON.stringify(e)).not.toContain('PRVBMB')
    expect(JSON.stringify(e)).not.toContain('testo libero')
  })
  it('un jsonb malformato non lancia', () => {
    for (const brutto of [null, undefined, 'x', 3, [], { children: 'no', adults: {} }, { children: [null, 5], adults: [null, 'a'] }]) {
      const e = estraiDaDomanda(brutto)
      expect(Array.isArray(e.figli)).toBe(true)
      expect(e.telefoni).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// collegaDomandaAlCrm
// ─────────────────────────────────────────────────────────────────────────────

describe('collegaDomandaAlCrm · il collegamento automatico', () => {
  function dbBase(telDomanda = '+39 333 000 0001', emailDomanda = 'prova@example.com'): DBFinto {
    return {
      enrollment_submissions: [
        domanda(D1, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05')], [adultoDomanda({ phone: telDomanda, email: emailDomanda })]),
      ],
      crm_schede: [scheda(S1, SEDE_A, { tel: ['3330000001'] })],
      crm_bambini: [bambino(B1, S1, SEDE_A)],
      crm_eventi: [],
    }
  }

  it('stesso telefono scritto +39 e con spazi → collegato', async () => {
    const { client, db, scritture } = conDb(dbBase('+39 333 000 0001'))
    const r = await collegaDomandaAlCrm(client, D1)
    expect(r).toEqual({ esito: 'collegato', schedaId: S1, bambini: 1 })

    const riga = (db.crm_bambini as Riga[])[0]
    expect(riga).toMatchObject({
      esito: 'iscritto',
      esito_origine: 'automatico',
      domanda_id: D1,
      domanda_figlio: 0,
      da_verificare: false,
    })
    expect(typeof riga.esito_il).toBe('string')
    expect(typeof riga.domanda_collegata_il).toBe('string')

    // L'update porta la sede e «non ancora collegato» NELLA STESSA istruzione.
    expect(aggiornamentiBambini(scritture)).toHaveLength(1)
    expect(eventiScritti(db)).toEqual([
      expect.objectContaining({ scheda_id: S1, scuola_id: SEDE_A, tipo: 'domanda_collegata_auto', autore: null, autore_via: 'sistema' }),
    ])
  })

  it.each([['0039 333-0000001'], ['333 0000001'], ['(+39) 333.000.0001']])('telefono scritto «%s» → collegato', async (tel) => {
    const { client } = conDb(dbBase(tel))
    expect((await collegaDomandaAlCrm(client, D1)).esito).toBe('collegato')
  })

  it('email in maiuscolo → collegato', async () => {
    const db = dbBase('', '  Prova@Example.COM ')
    db.crm_schede = [scheda(S1, SEDE_A, { email: ['prova@example.com'] })]
    const { client } = conDb(db)
    expect((await collegaDomandaAlCrm(client, D1)).esito).toBe('collegato')
  })

  it('il secondo telefono dell’altro genitore coincide → collegato', async () => {
    const db = dbBase()
    ;(db.enrollment_submissions as Riga[])[0] = domanda(
      D1,
      SEDE_A,
      [figlioDomanda('Bimbo', '2024-03-05')],
      [adultoDomanda({ phone: '', email: '' }), adultoDomanda({ ruolo: 'father', phone: '3330000001', email: '' })],
    )
    const { client } = conDb(db)
    expect((await collegaDomandaAlCrm(client, D1)).esito).toBe('collegato')
  })

  it('telefono uguale ma scheda di un’altra sede → nessuna_scheda, log senza dati, nessun bambino toccato', async () => {
    const db = dbBase()
    db.crm_schede = [scheda(S1, SEDE_B, { tel: ['3330000001'] })]
    db.crm_bambini = [bambino(B1, S1, SEDE_B)]
    const { client, scritture } = conDb(db)

    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'nessuna_scheda' })

    expect(aggiornamentiBambini(scritture)).toHaveLength(0)
    expect((db.crm_bambini as Riga[])[0].domanda_id).toBeNull()
    expect(eventiScritti(db)).toHaveLength(0)
    const riga = h.log.find((r) => r.campi.esito === 'coincidenza-altra-sede')
    expect(riga).toBeDefined()
    expect(riga!.evento).toBe('crm')
    expect(riga!.livello).toBe('info')
    expect(riga!.campi.entita_id).toBe(D1)
    // Solo l'esito e l'id della domanda: niente telefono, niente id della scheda straniera.
    expect(Object.keys(riga!.campi).sort()).toEqual(['entita_id', 'esito'])
  })

  it('una scheda della sede e una di un’altra sede con lo stesso telefono → si collega solo quella della sede', async () => {
    const db = dbBase()
    ;(db.crm_schede as Riga[]).push(scheda(S2, SEDE_B, { tel: ['3330000001'] }))
    ;(db.crm_bambini as Riga[]).push(bambino(B2, S2, SEDE_B))
    const { client } = conDb(db)
    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'collegato', schedaId: S1, bambini: 1 })
    expect((db.crm_bambini as Riga[]).find((x) => x.id === B2)!.domanda_id).toBeNull()
  })

  it('due bambini e due figli con date diverse → due coppie, due eventi', async () => {
    const db = dbBase()
    ;(db.enrollment_submissions as Riga[])[0] = domanda(
      D1,
      SEDE_A,
      [figlioDomanda('Bimba', '2022-07-09'), figlioDomanda('Bimbo', '2024-03-05')],
      [adultoDomanda()],
    )
    ;(db.crm_bambini as Riga[]).push(bambino(B2, S1, SEDE_A, { nome: 'Bimba', data_nascita: '2022-07-09' }))
    const { client } = conDb(db)

    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'collegato', schedaId: S1, bambini: 2 })
    const per = (id: string) => (db.crm_bambini as Riga[]).find((x) => x.id === id)!
    expect(per(B1)).toMatchObject({ domanda_id: D1, domanda_figlio: 1, esito: 'iscritto' })
    expect(per(B2)).toMatchObject({ domanda_id: D1, domanda_figlio: 0, esito: 'iscritto' })
    expect(eventiScritti(db).filter((e) => e.tipo === 'domanda_collegata_auto')).toHaveLength(2)
  })

  it('una famiglia con due bambini, se ne iscrive uno → l’altro resta com’è', async () => {
    const db = dbBase()
    ;(db.crm_bambini as Riga[]).push(bambino(B2, S1, SEDE_A, { nome: 'Bimba', data_nascita: '2022-07-09' }))
    const { client } = conDb(db)
    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'collegato', schedaId: S1, bambini: 1 })
    expect((db.crm_bambini as Riga[]).find((x) => x.id === B2)).toMatchObject({ esito: 'aperto', domanda_id: null })
  })

  it('un bambino già «iscritto a mano» conserva chi e quando l’ha segnato; prende solo il collegamento', async () => {
    const db = dbBase()
    ;(db.crm_bambini as Riga[])[0] = bambino(B1, S1, SEDE_A, {
      esito: 'iscritto',
      esito_origine: 'manuale',
      esito_da: UTENTE,
      esito_il: mesiFa(1),
    })
    const prima = (db.crm_bambini as Riga[])[0].esito_il
    const { client } = conDb(db)
    await collegaDomandaAlCrm(client, D1)
    expect((db.crm_bambini as Riga[])[0]).toMatchObject({
      esito: 'iscritto',
      esito_origine: 'manuale',
      esito_da: UTENTE,
      esito_il: prima,
      domanda_id: D1,
    })
  })

  it('due bambini senza data e un figlio → da_associare, nessun bambino iscritto', async () => {
    const db = dbBase()
    ;(db.enrollment_submissions as Riga[])[0] = domanda(D1, SEDE_A, [figlioDomanda('Altro', null)], [adultoDomanda()])
    db.crm_bambini = [
      bambino(B1, S1, SEDE_A, { nome: null, data_nascita: null }),
      bambino(B2, S1, SEDE_A, { nome: null, data_nascita: null }),
    ]
    const { client } = conDb(db)

    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'da_associare', schedaIds: [S1] })
    expect((db.crm_bambini as Riga[]).every((x) => x.esito === 'aperto' && x.domanda_id === null)).toBe(true)
    expect((db.crm_schede as Riga[])[0].domanda_da_associare).toBe(D1)
    expect(eventiScritti(db)).toEqual([expect.objectContaining({ scheda_id: S1, tipo: 'domanda_da_associare' })])
  })

  it('due schede della sede coincidono → da_associare su entrambe, nessun bambino iscritto', async () => {
    const db = dbBase()
    ;(db.crm_schede as Riga[]).push(scheda(S2, SEDE_A, { tel: ['3330000001'] }))
    ;(db.crm_bambini as Riga[]).push(bambino(B2, S2, SEDE_A))
    const { client } = conDb(db)

    const r = await collegaDomandaAlCrm(client, D1)
    expect(r.esito).toBe('da_associare')
    expect((r as { schedaIds: string[] }).schedaIds.sort()).toEqual([S1, S2].sort())
    expect((db.crm_bambini as Riga[]).every((x) => x.domanda_id === null && x.esito === 'aperto')).toBe(true)
    expect((db.crm_schede as Riga[]).map((s) => s.domanda_da_associare)).toEqual([D1, D1])
    expect(eventiScritti(db).filter((e) => e.tipo === 'domanda_da_associare')).toHaveLength(2)
  })

  it('nessuna scheda con quel contatto → nessuna_scheda', async () => {
    const db = dbBase('+39 333 999 9999', 'altra@example.com')
    const { client } = conDb(db)
    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'nessuna_scheda' })
    expect(h.log.some((r) => r.campi.esito === 'nessuna-scheda' && r.campi.entita_id === D1)).toBe(true)
  })

  it('una domanda senza telefono né email validi → nessuna_scheda, senza interrogare il CRM', async () => {
    const db = dbBase('12', 'senza-chiocciola')
    const letture: string[] = []
    const client = creaFintoSupabase(db, letture)
    expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'nessuna_scheda' })
    expect(letture.filter((t) => t.startsWith('crm_'))).toEqual([])
  })

  describe('quali schede contano (spec §7: aperte o create negli ultimi 12 mesi)', () => {
    it('una scheda di 13 mesi fa con il solo bambino già iscritto non contano → nessuna_scheda', async () => {
      const db = dbBase()
      db.crm_schede = [scheda(S1, SEDE_A, { tel: ['3330000001'] }, { creata_il: mesiFa(13) })]
      db.crm_bambini = [bambino(B1, S1, SEDE_A, { esito: 'iscritto', domanda_id: null })]
      const { client } = conDb(db)
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'nessuna_scheda' })
    })
    it.each(['aperto', 'ci_pensa', 'lista_attesa'])('una scheda vecchia con un bambino «%s» conta ancora', async (esito) => {
      const db = dbBase()
      db.crm_schede = [scheda(S1, SEDE_A, { tel: ['3330000001'] }, { creata_il: mesiFa(20) })]
      db.crm_bambini = [bambino(B1, S1, SEDE_A, { esito })]
      const { client } = conDb(db)
      expect((await collegaDomandaAlCrm(client, D1)).esito).toBe('collegato')
    })
    it('una scheda vecchia con il solo bambino «perso» non conta', async () => {
      const db = dbBase()
      db.crm_schede = [scheda(S1, SEDE_A, { tel: ['3330000001'] }, { creata_il: mesiFa(20) })]
      db.crm_bambini = [bambino(B1, S1, SEDE_A, { esito: 'perso' })]
      const { client } = conDb(db)
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'nessuna_scheda' })
    })
    it('una scheda recente conta anche se il bambino è «perso»', async () => {
      const db = dbBase()
      db.crm_bambini = [bambino(B1, S1, SEDE_A, { esito: 'perso' })]
      const { client } = conDb(db)
      expect((await collegaDomandaAlCrm(client, D1)).esito).toBe('collegato')
    })
  })

  describe('la domanda ha già un collegamento', () => {
    it('la stessa domanda lanciata due volte → la seconda non fa niente e non duplica lo storico', async () => {
      const { client, db } = conDb(dbBase())
      await collegaDomandaAlCrm(client, D1)
      const eventi = eventiScritti(db).length
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'collegato', schedaId: S1, bambini: 1 })
      expect(eventiScritti(db)).toHaveLength(eventi)
    })

    it('seconda domanda per lo stesso bambino → non si collega: nota «altra_domanda» ed evento', async () => {
      const db = dbBase()
      ;(db.crm_bambini as Riga[])[0] = bambino(B1, S1, SEDE_A, { esito: 'iscritto', domanda_id: D2, domanda_figlio: 0 })
      const { client } = conDb(db)

      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'altra_domanda', schedaId: S1 })
      expect((db.crm_bambini as Riga[])[0]).toMatchObject({ domanda_id: D2, nota_collegamento: 'altra_domanda' })
      expect(eventiScritti(db)).toEqual([expect.objectContaining({ scheda_id: S1, tipo: 'altra_domanda' })])
      // La scheda non chiede di «associare» niente: il bambino ha già la sua domanda.
      expect((db.crm_schede as Riga[])[0].domanda_da_associare).toBeNull()
    })

    it('un figlio già collegato a un altro bambino (23505) → «altra_domanda», nota ed evento, nessuna eccezione', async () => {
      const { client, db } = conDb(dbBase(), { 'crm_bambini:update': { code: '23505', message: 'duplicate key' } })
      const r = await collegaDomandaAlCrm(client, D1)
      expect(r).toEqual({ esito: 'altra_domanda', schedaId: S1 })
      // Il collegamento è stato respinto dal database: il bambino non è stato toccato.
      expect((db.crm_bambini as Riga[])[0].domanda_id).toBeNull()
      expect(eventiScritti(db)).toEqual([expect.objectContaining({ scheda_id: S1, tipo: 'altra_domanda' })])
      expect(h.log.some((x) => x.livello === 'error' && x.campi.esito === 'errore')).toBe(false)
    })
  })

  describe('i guasti non arrivano mai a chi chiama', () => {
    it('tabelle assenti (PGRST205) → non_installato, warn, nessuna eccezione', async () => {
      const { client } = conDb(dbBase(), { crm_schede: { code: 'PGRST205', message: "Could not find the table 'public.crm_schede'" } })
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'non_installato' })
      expect(h.log.some((r) => r.evento === 'crm' && r.livello === 'warn' && r.campi.entita_id === D1)).toBe(true)
    })
    it('tabelle assenti (42P01) → non_installato', async () => {
      const { client } = conDb(dbBase(), { crm_schede: { code: '42P01' } })
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'non_installato' })
    })
    it('errore del database → errore, nessuna eccezione, logEvento crm error', async () => {
      const { client } = conDb(dbBase(), { crm_schede: { code: 'XX000', message: 'boom' } })
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'errore' })
      expect(h.log.some((r) => r.evento === 'crm' && r.livello === 'error' && r.campi.entita_id === D1)).toBe(true)
    })
    it('il client che LANCIA → errore, nessuna eccezione, logEvento crm error', async () => {
      const lancia = {
        from: () => {
          throw new Error('rete caduta')
        },
      } as unknown as SupabaseClient
      expect(await collegaDomandaAlCrm(lancia, D1)).toEqual({ esito: 'errore' })
      expect(h.log.some((r) => r.evento === 'crm' && r.livello === 'error' && r.campi.entita_id === D1)).toBe(true)
    })
    it('la domanda non si legge → errore', async () => {
      const { client } = conDb(dbBase(), { 'enrollment_submissions:select': { code: 'XX000' } })
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'errore' })
    })
    it('la domanda non esiste → errore (e un log), non un’eccezione', async () => {
      const { client } = conDb(dbBase())
      expect(await collegaDomandaAlCrm(client, D3)).toEqual({ esito: 'errore' })
    })
    it('una domanda senza sede non si collega a niente', async () => {
      const db = dbBase()
      ;(db.enrollment_submissions as Riga[])[0].scuola_id = null
      const { client, scritture } = conDb(db)
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'nessuna_scheda' })
      expect(scritture).toHaveLength(0)
    })
    it('l’update di un bambino fallisce con un errore qualsiasi → errore, nessuna eccezione', async () => {
      const { client, db } = conDb(dbBase(), { 'crm_bambini:update': { code: 'XX000' } })
      expect(await collegaDomandaAlCrm(client, D1)).toEqual({ esito: 'errore' })
      expect((db.crm_bambini as Riga[])[0].domanda_id).toBeNull()
    })
  })

  it('ogni esito lascia una riga di log con esito e id della domanda (il battito)', async () => {
    const { client } = conDb(dbBase())
    await collegaDomandaAlCrm(client, D1)
    const battito = h.log.find((r) => r.campi.esito === 'collegato')
    expect(battito).toMatchObject({ evento: 'crm', livello: 'info' })
    expect(battito!.campi.entita_id).toBe(D1)
    expect(battito!.campi.scuola_id).toBe(SEDE_A)
    expect(battito!.campi.n_bambini).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le istruzioni che il collegamento scrive portano la sede e «non ancora collegato»
// ─────────────────────────────────────────────────────────────────────────────

describe('collegaDomandaAlCrm · la forma delle istruzioni', () => {
  it('ogni update di un bambino porta .eq(scuola_id) e .is(domanda_id, null) NELLA STESSA istruzione', async () => {
    const chiamate: { tabella: string; metodi: [string, unknown[]][] }[] = []
    const tabelle: Record<string, Riga[]> = {
      enrollment_submissions: [domanda(D1, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05')], [adultoDomanda()])],
      crm_schede: [scheda(S1, SEDE_A, { tel: ['3330000001'] })],
      crm_bambini: [bambino(B1, S1, SEDE_A)],
    }
    // Un client che REGISTRA la catena di metodi e risponde con righe fisse: qui non interessa cosa
    // torna, interessa che la catena dell'update contenga i due filtri.
    const client = {
      from(tabella: string) {
        const rec = { tabella, metodi: [] as [string, unknown[]][] }
        chiamate.push(rec)
        const risposta = () => ({ data: tabelle[tabella] ?? [], error: null })
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, nome: string) {
              if (nome === 'then') return (ok: (v: unknown) => unknown) => Promise.resolve(risposta()).then(ok)
              if (nome === 'maybeSingle' || nome === 'single') {
                return async () => ({ data: (tabelle[tabella] ?? [])[0] ?? null, error: null })
              }
              return (...args: unknown[]) => {
                rec.metodi.push([nome, args])
                return proxy
              }
            },
          },
        )
        return proxy
      },
    } as unknown as SupabaseClient

    await collegaDomandaAlCrm(client, D1)

    const update = chiamate.find((c) => c.tabella === 'crm_bambini' && c.metodi.some(([m]) => m === 'update'))
    expect(update, 'nessun update su crm_bambini').toBeDefined()
    expect(update!.metodi).toContainEqual(['eq', ['scuola_id', SEDE_A]])
    expect(update!.metodi).toContainEqual(['is', ['domanda_id', null]])
    expect(update!.metodi).toContainEqual(['eq', ['id', B1]])

    // La lettura «questa domanda è già collegata?» cerca per domanda E per sede nella stessa istruzione.
    const idempotenza = chiamate.find(
      (c) => c.tabella === 'crm_bambini' && c.metodi.some(([m, args]) => m === 'eq' && args[0] === 'domanda_id'),
    )
    expect(idempotenza, 'manca la lettura di idempotenza').toBeDefined()
    expect(idempotenza!.metodi).toContainEqual(['eq', ['domanda_id', D1]])
    expect(idempotenza!.metodi).toContainEqual(['eq', ['scuola_id', SEDE_A]])

    // E ogni LISTA su crm_* porta il filtro di sede nella stessa query.
    for (const c of chiamate.filter((x) => x.tabella.startsWith('crm_') && !x.metodi.some(([m]) => ['update', 'insert'].includes(m)))) {
      const haSede = c.metodi.some(([m, a]) => (m === 'eq' && a[0] === 'scuola_id') || (m === 'in' && a[0] === 'scuola_id'))
      const eConfrontoAltreSedi = c.metodi.some(([m, a]) => m === 'neq' && a[0] === 'scuola_id')
      expect(haSede || eConfrontoAltreSedi, `lettura di ${c.tabella} senza filtro di sede`).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// segnalaDomandaRespinta / segnalaDomandeCancellate
// ─────────────────────────────────────────────────────────────────────────────

describe('segnalaDomandaRespinta', () => {
  function dbCollegato(): DBFinto {
    return {
      enrollment_submissions: [domanda(D1, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05')], [adultoDomanda()], { status: 'rejected' })],
      crm_schede: [scheda(S1, SEDE_A, { tel: ['3330000001'] })],
      crm_bambini: [
        bambino(B1, S1, SEDE_A, { esito: 'iscritto', esito_origine: 'automatico', domanda_id: D1, domanda_figlio: 0 }),
        bambino(B2, S1, SEDE_A, { nome: 'Bimba', esito: 'aperto' }),
      ],
      crm_eventi: [],
    }
  }
  it('domanda respinta → da_verificare true, nota «domanda_respinta», evento domanda_respinta', async () => {
    const { client, db } = conDb(dbCollegato())
    await segnalaDomandaRespinta(client, D1)
    expect((db.crm_bambini as Riga[]).find((x) => x.id === B1)).toMatchObject({
      da_verificare: true,
      nota_collegamento: 'domanda_respinta',
      esito: 'iscritto',
    })
    // L'altro bambino della scheda non c'entra.
    expect((db.crm_bambini as Riga[]).find((x) => x.id === B2)).toMatchObject({ da_verificare: false, nota_collegamento: null })
    expect(eventiScritti(db)).toEqual([
      expect.objectContaining({ scheda_id: S1, scuola_id: SEDE_A, tipo: 'domanda_respinta', autore: null, autore_via: 'sistema' }),
    ])
  })
  it('un bambino di un’altra sede con lo stesso domanda_id non si tocca', async () => {
    const db = dbCollegato()
    ;(db.crm_schede as Riga[]).push(scheda(S2, SEDE_B, {}))
    ;(db.crm_bambini as Riga[]).push(bambino(B3, S2, SEDE_B, { domanda_id: D1, domanda_figlio: 5 }))
    const { client } = conDb(db)
    await segnalaDomandaRespinta(client, D1)
    expect((db.crm_bambini as Riga[]).find((x) => x.id === B3)).toMatchObject({ da_verificare: false })
  })
  it('una domanda senza bambini collegati non fa niente (e lo dice nel log)', async () => {
    const { client, db } = conDb(dbCollegato())
    await segnalaDomandaRespinta(client, D2)
    expect(eventiScritti(db)).toHaveLength(0)
  })
  it('non lancia mai: tabella assente, errore o client che lancia', async () => {
    await expect(segnalaDomandaRespinta(conDb(dbCollegato(), { crm_bambini: { code: 'PGRST205' } }).client, D1)).resolves.toBeUndefined()
    await expect(segnalaDomandaRespinta(conDb(dbCollegato(), { crm_bambini: { code: 'XX000' } }).client, D1)).resolves.toBeUndefined()
    const lancia = { from: () => { throw new Error('x') } } as unknown as SupabaseClient
    await expect(segnalaDomandaRespinta(lancia, D1)).resolves.toBeUndefined()
    expect(h.log.some((r) => r.livello === 'error')).toBe(true)
  })
})

describe('segnalaDomandeCancellate', () => {
  function dbDueDomande(): DBFinto {
    return {
      enrollment_submissions: [
        domanda(D1, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05')], [adultoDomanda()]),
        domanda(D2, SEDE_A, [figlioDomanda('Bimba', '2022-07-09')], [adultoDomanda()]),
        domanda(D3, SEDE_B, [figlioDomanda('Gemello', '2022-07-09')], [adultoDomanda()]),
      ],
      crm_schede: [scheda(S1, SEDE_A, {}), scheda(S2, SEDE_A, {}), scheda(S3, SEDE_B, {})],
      crm_bambini: [
        bambino(B1, S1, SEDE_A, { esito: 'iscritto', domanda_id: D1, domanda_figlio: 0 }),
        bambino(B2, S2, SEDE_A, { esito: 'iscritto', domanda_id: D2, domanda_figlio: 0 }),
        bambino(B3, S3, SEDE_B, { esito: 'iscritto', domanda_id: D3, domanda_figlio: 0 }),
      ],
      crm_eventi: [],
    }
  }
  it('scrive «collegamento_tolto» con motivo «domanda_cancellata» sulle sole schede delle domande indicate', async () => {
    const { client, db } = conDb(dbDueDomande())
    await segnalaDomandeCancellate(client, [D1, D3])
    const eventi = eventiScritti(db)
    expect(eventi.map((e) => e.scheda_id).sort()).toEqual([S1, S3].sort())
    for (const e of eventi) {
      expect(e).toMatchObject({ tipo: 'collegamento_tolto', autore: null, autore_via: 'sistema' })
      expect(e.dati).toMatchObject({ motivo: 'domanda_cancellata' })
    }
    // Ogni evento porta la sede DELLA SUA scheda.
    expect(eventi.find((e) => e.scheda_id === S3)!.scuola_id).toBe(SEDE_B)
  })
  it('un elenco vuoto non interroga nemmeno il database', async () => {
    const letture: string[] = []
    const client = creaFintoSupabase(dbDueDomande(), letture)
    await segnalaDomandeCancellate(client, [])
    expect(letture).toEqual([])
  })
  it('un guasto non ferma chi sta per cancellare: nessuna eccezione, log di errore', async () => {
    await expect(
      segnalaDomandeCancellate(conDb(dbDueDomande(), { crm_bambini: { code: 'XX000' } }).client, [D1]),
    ).resolves.toBeUndefined()
    expect(h.log.some((r) => r.livello === 'error')).toBe(true)
    const lancia = { from: () => { throw new Error('x') } } as unknown as SupabaseClient
    await expect(segnalaDomandeCancellate(lancia, [D1])).resolves.toBeUndefined()
  })
  it('tabelle assenti → nessun errore, solo un warn', async () => {
    await expect(
      segnalaDomandeCancellate(conDb(dbDueDomande(), { crm_bambini: { code: 'PGRST205' } }).client, [D1]),
    ).resolves.toBeUndefined()
    expect(h.log.some((r) => r.livello === 'error')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// collegaAMano / scollega
// ─────────────────────────────────────────────────────────────────────────────

describe('collegaAMano', () => {
  function dbMano(): DBFinto {
    return {
      enrollment_submissions: [
        domanda(D1, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05'), figlioDomanda('Bimba', '2022-07-09')], [adultoDomanda()]),
        domanda(D2, SEDE_B, [figlioDomanda('Gemello', '2022-07-09')], [adultoDomanda()]),
        domanda(D3, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05')], [adultoDomanda()], { status: 'rejected' }),
      ],
      crm_schede: [scheda(S1, SEDE_A, { tel: ['3330000001'] }, { domanda_da_associare: D1 })],
      crm_bambini: [bambino(B1, S1, SEDE_A, { esito: 'iscritto', esito_origine: 'manuale', esito_da: UTENTE, esito_il: mesiFa(1) })],
      crm_eventi: [],
    }
  }
  const richiesta = (extra: Record<string, unknown> = {}) => ({
    schedaId: S1,
    scuolaId: SEDE_A,
    bambinoId: B1,
    domandaId: D1,
    figlio: 0,
    autore: UTENTE,
    ...extra,
  })

  it('collega il figlio scelto: null, evento domanda_collegata_mano, avviso azzerato', async () => {
    const { client, db } = conDb(dbMano())
    expect(await collegaAMano(client, richiesta({ figlio: 1 }))).toBeNull()
    expect((db.crm_bambini as Riga[])[0]).toMatchObject({
      domanda_id: D1,
      domanda_figlio: 1,
      da_verificare: false,
      nota_collegamento: null,
      // era «iscritto a mano»: chi e quando l’ha segnato resta
      esito: 'iscritto',
      esito_origine: 'manuale',
      esito_da: UTENTE,
    })
    expect(typeof (db.crm_bambini as Riga[])[0].domanda_collegata_il).toBe('string')
    expect(eventiScritti(db)).toEqual([
      expect.objectContaining({ scheda_id: S1, scuola_id: SEDE_A, tipo: 'domanda_collegata_mano', autore: UTENTE, autore_via: 'segreteria' }),
    ])
    expect((db.crm_schede as Riga[])[0].domanda_da_associare).toBeNull()
  })

  it('un bambino ancora «aperto» diventa iscritto, a mano, per mano di chi ha collegato', async () => {
    const db = dbMano()
    ;(db.crm_bambini as Riga[])[0] = bambino(B1, S1, SEDE_A)
    const { client } = conDb(db)
    expect(await collegaAMano(client, richiesta())).toBeNull()
    expect((db.crm_bambini as Riga[])[0]).toMatchObject({ esito: 'iscritto', esito_origine: 'manuale', esito_da: UTENTE })
  })

  it('l’avviso di UN’ALTRA domanda non si azzera', async () => {
    const db = dbMano()
    ;(db.crm_schede as Riga[])[0].domanda_da_associare = D3
    const { client } = conDb(db)
    await collegaAMano(client, richiesta())
    expect((db.crm_schede as Riga[])[0].domanda_da_associare).toBe(D3)
  })

  it('una domanda respinta si collega, ma il bambino va fra quelli «da verificare»', async () => {
    const { client, db } = conDb(dbMano())
    expect(await collegaAMano(client, richiesta({ domandaId: D3 }))).toBeNull()
    expect((db.crm_bambini as Riga[])[0]).toMatchObject({ domanda_id: D3, da_verificare: true, nota_collegamento: 'domanda_respinta' })
  })

  it('collegaAMano su un figlio già collegato → 409 GIA_COLLEGATO', async () => {
    const { client } = conDb(dbMano(), { 'crm_bambini:update': { code: '23505', message: 'duplicate key value' } })
    const r = await collegaAMano(client, richiesta())
    expect(r).not.toBeNull()
    expect(r!.status).toBe(409)
    expect((await r!.json()).codice).toBe('GIA_COLLEGATO')
  })

  it('una domanda di un’altra sede → 403, niente scritto', async () => {
    const { client, db, scritture } = conDb(dbMano())
    const r = await collegaAMano(client, richiesta({ domandaId: D2 }))
    expect(r!.status).toBe(403)
    expect((await r!.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(scritture).toHaveLength(0)
    expect((db.crm_bambini as Riga[])[0].domanda_id).toBeNull()
  })

  it('un bambino che non è di quella scheda e di quella sede → 404 SCHEDA_NON_TROVATA', async () => {
    const db = dbMano()
    ;(db.crm_schede as Riga[]).push(scheda(S2, SEDE_B, {}))
    ;(db.crm_bambini as Riga[]).push(bambino(B2, S2, SEDE_B))
    const { client, scritture } = conDb(db)
    for (const r of [richiesta({ bambinoId: B2 }), richiesta({ schedaId: S2 }), richiesta({ bambinoId: B3 })]) {
      const esito = await collegaAMano(client, r)
      expect(esito!.status).toBe(404)
      expect((await esito!.json()).codice).toBe('SCHEDA_NON_TROVATA')
    }
    expect(scritture).toHaveLength(0)
  })

  it('una domanda che non esiste → 404 DOMANDA_NON_APRIBILE', async () => {
    const { client } = conDb(dbMano())
    const r = await collegaAMano(client, richiesta({ domandaId: 'f0f0f0f0-0000-4000-8000-000000000009' }))
    expect(r!.status).toBe(404)
    expect((await r!.json()).codice).toBe('DOMANDA_NON_APRIBILE')
  })

  it('un figlio che nella domanda non c’è → 400', async () => {
    const { client, scritture } = conDb(dbMano())
    const r = await collegaAMano(client, richiesta({ figlio: 7 }))
    expect(r!.status).toBe(400)
    expect(scritture).toHaveLength(0)
  })

  it('un bambino già collegato a una domanda → 409 STATO_NON_AMMESSO: prima si scollega', async () => {
    const db = dbMano()
    ;(db.crm_bambini as Riga[])[0].domanda_id = D3
    const { client } = conDb(db)
    const r = await collegaAMano(client, richiesta())
    expect(r!.status).toBe(409)
    expect((await r!.json()).codice).toBe('STATO_NON_AMMESSO')
  })

  it('tabella assente → 503 CRM_NON_INSTALLATO', async () => {
    const { client } = conDb(dbMano(), { crm_bambini: { code: 'PGRST205' } })
    const r = await collegaAMano(client, richiesta())
    expect(r!.status).toBe(503)
  })

  it('corsa: se fra la lettura e la scrittura un’altra segretaria collega il bambino → 409 e nessuna sovrascrittura', async () => {
    const { client: vero, db } = conDb(dbMano())
    const letto = db.crm_bambini as Riga[]
    // Un client che lascia passare tutto, ma un istante PRIMA dell'update su crm_bambini fa arrivare
    // l'altra segretaria: l'update di collegaAMano porta `.is('domanda_id', null)`, quindi tocca zero righe.
    const client = {
      from: (t: string) => {
        const q = vero.from(t)
        if (t !== 'crm_bambini') return q
        return new Proxy(q as object, {
          get(target, prop) {
            const v = Reflect.get(target, prop)
            if (prop === 'update') {
              return (...args: unknown[]) => {
                letto[0].domanda_id = D3
                return (v as (...a: unknown[]) => unknown)(...args)
              }
            }
            return typeof v === 'function' ? v.bind(target) : v
          },
        })
      },
    } as unknown as SupabaseClient

    const r = await collegaAMano(client, richiesta())
    expect(r!.status).toBe(409)
    expect((await r!.json()).codice).toBe('STATO_NON_AMMESSO')
    expect(letto[0].domanda_id).toBe(D3) // non sovrascritta
    expect(eventiScritti(db)).toHaveLength(0)
  })
})

describe('scollega', () => {
  function dbCollegato(extra: Riga = {}): DBFinto {
    return {
      enrollment_submissions: [domanda(D1, SEDE_A, [figlioDomanda('Bimbo', '2024-03-05')], [adultoDomanda()])],
      crm_schede: [scheda(S1, SEDE_A, {}, { domanda_da_associare: D1 })],
      crm_bambini: [
        bambino(B1, S1, SEDE_A, {
          esito: 'iscritto',
          esito_origine: 'automatico',
          domanda_id: D1,
          domanda_figlio: 0,
          domanda_collegata_il: mesiFa(1),
          da_verificare: true,
          nota_collegamento: 'domanda_respinta',
          ...extra,
        }),
      ],
      crm_eventi: [],
    }
  }
  const r = (extra: Record<string, unknown> = {}) => ({ schedaId: S1, scuolaId: SEDE_A, bambinoId: B1, autore: UTENTE, ...extra })

  it('azzera il collegamento, lascia l’esito, scrive collegamento_tolto', async () => {
    const { client, db } = conDb(dbCollegato())
    expect(await scollega(client, r())).toBeNull()
    expect((db.crm_bambini as Riga[])[0]).toMatchObject({
      esito: 'iscritto',
      domanda_id: null,
      domanda_figlio: null,
      domanda_collegata_il: null,
      da_verificare: false,
      nota_collegamento: null,
    })
    expect(eventiScritti(db)).toEqual([
      expect.objectContaining({ scheda_id: S1, scuola_id: SEDE_A, tipo: 'collegamento_tolto', autore: UTENTE, autore_via: 'segreteria' }),
    ])
    // L'avviso che riguardava QUELLA domanda si spegne.
    expect((db.crm_schede as Riga[])[0].domanda_da_associare).toBeNull()
  })
  it('l’avviso di un’altra domanda resta', async () => {
    const db = dbCollegato()
    ;(db.crm_schede as Riga[])[0].domanda_da_associare = D2
    const { client } = conDb(db)
    await scollega(client, r())
    expect((db.crm_schede as Riga[])[0].domanda_da_associare).toBe(D2)
  })
  it('«domanda non più presente» (domanda_id nullo, collegata_il valorizzata) si può ripulire', async () => {
    const { client, db } = conDb(dbCollegato({ domanda_id: null, domanda_figlio: null, da_verificare: false, nota_collegamento: null }))
    expect(await scollega(client, r())).toBeNull()
    expect((db.crm_bambini as Riga[])[0].domanda_collegata_il).toBeNull()
  })
  it('un bambino senza alcun collegamento → 409 STATO_NON_AMMESSO', async () => {
    const { client } = conDb(dbCollegato({ domanda_id: null, domanda_figlio: null, domanda_collegata_il: null }))
    const esito = await scollega(client, r())
    expect(esito!.status).toBe(409)
  })
  it('bambino di un’altra scheda o sede → 404, niente scritto', async () => {
    const { client, scritture } = conDb(dbCollegato())
    const esito = await scollega(client, r({ scuolaId: SEDE_B }))
    expect(esito!.status).toBe(404)
    expect(scritture).toHaveLength(0)
  })
  it('l’update porta la sede', async () => {
    const { client, db } = conDb(dbCollegato())
    ;(db.crm_bambini as Riga[]).push(bambino(B2, S1, SEDE_B, { domanda_id: D1, domanda_figlio: 3 }))
    await scollega(client, r())
    // Il bambino di un'altra sede (anche con lo stesso domanda_id) non è toccato.
    expect((db.crm_bambini as Riga[]).find((x) => x.id === B2)!.domanda_id).toBe(D1)
  })
})
