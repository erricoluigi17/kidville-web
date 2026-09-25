import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

// =============================================================================
// CHI PUÒ MODIFICARE/ELIMINARE UNA VOCE DELLA PRIMARIA, E FINO A QUANDO.
//
// Il finto client filtra DAVVERO (`creaFintoSupabase`): «lo sblocco del giorno
// di un'altra classe non vale» è verificato sui dati, non asserito da un mock
// che risponde sempre la stessa cosa. L'orologio è un ISTANTE fisso passato come
// argomento: nessun caso dipende dal giorno in cui gira.
// =============================================================================

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

import {
  chiaveVoce,
  dataEventoDaIstante,
  rispostaPermessoNegato,
  statoVoci,
  verificaPermessoVoce,
  type VocePrimaria,
} from '@/lib/primaria/permesso-voce'

const MAESTRA = 'd0ce0001-0000-4000-8000-000000000001'
const COLLEGA = 'd0ce0002-0000-4000-8000-000000000002'
const ESTRANEA = 'd0ce0003-0000-4000-8000-000000000003'
const SEGRETERIA = '5e690001-0000-4000-8000-000000000004'
const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000005'
const SEZ_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const VOCE_1 = 'e9157200-0000-4000-8000-000000000001'
const VOCE_2 = 'e9157200-0000-4000-8000-000000000002'
const VOCE_3 = 'e9157200-0000-4000-8000-000000000003'

/** 12:00 del 10/09/2026 a Roma. */
const ADESSO = new Date('2026-09-10T10:00:00Z')
const IERI = '2026-09-09' // 1 giorno: entro il termine di 2
const LUNEDI = '2026-09-07' // 3 giorni: oltre il termine di 2
const MARTEDI = '2026-09-08' // 2 giorni: ancora entro

const maestra: AppUser = { id: MAESTRA, role: 'educator' }
const collega: AppUser = { id: COLLEGA, role: 'educator' }
const estranea: AppUser = { id: ESTRANEA, role: 'educator' }
const segreteria: AppUser = { id: SEGRETERIA, role: 'segreteria' }
const dirigente: AppUser = { id: DIRIGENTE, role: 'coordinator' }

let db: DBFinto
let tabelle: string[]
let opzioni: OpzioniFinto
/** `true` ⇒ la SELECT per giorno/slot di `sblocchi_audit` risponde 42703 (DB E2E non migrato). */
let senzaColonneGiorno: boolean

function voce(extra: Partial<VocePrimaria> = {}): VocePrimaria {
  return {
    tipo: 'valutazione',
    id: VOCE_1,
    autoreId: MAESTRA,
    sectionId: SEZ_A,
    scuolaId: SEDE_A,
    dataEvento: IERI,
    ...extra,
  }
}

function client(): SupabaseClient {
  const vero = creaFintoSupabase(db, tabelle, opzioni)
  if (!senzaColonneGiorno) return vero
  const grezzo = vero as unknown as { from: (t: string) => Record<string, unknown> }
  return {
    from(tabella: string) {
      const qb = grezzo.from(tabella)
      if (tabella !== 'sblocchi_audit') return qb
      const selectVero = qb.select as (c: string) => unknown
      qb.select = (colonne: string) => {
        if (!colonne.includes('section_id')) return selectVero.call(qb, colonne)
        const error = { code: '42703', message: 'column sblocchi_audit.section_id does not exist' }
        const respinto: Record<string, unknown> = {
          in: () => respinto,
          eq: () => respinto,
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok),
        }
        return respinto
      }
      return qb
    },
  } as unknown as SupabaseClient
}

const letturaSblocchi = () => tabelle.filter((t) => t === 'sblocchi_audit').length

beforeEach(() => {
  h.logEvento.mockReset()
  tabelle = []
  opzioni = {}
  senzaColonneGiorno = false
  db = {
    admin_settings: [{ scuola_id: SEDE_A, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 }],
    utenti_sezioni: [
      { utente_id: MAESTRA, section_id: SEZ_A },
      { utente_id: COLLEGA, section_id: SEZ_A },
      { utente_id: ESTRANEA, section_id: SEZ_B },
    ],
    sblocchi_audit: [],
  }
})

describe('CHI — autore, Segreteria e Direzione', () => {
  it('l’autore, entro il termine, può; e non si leggono sblocchi che non servono', async () => {
    expect(await verificaPermessoVoce(client(), maestra, voce(), ADESSO)).toEqual({ ok: true })
    expect(letturaSblocchi()).toBe(0)
  })

  it('un’altra docente, anche della stessa classe, NO: 403 VOCE_NON_AUTORE', async () => {
    const esito = await verificaPermessoVoce(client(), collega, voce(), ADESSO)
    expect(esito).toEqual({ ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' })
    expect(letturaSblocchi()).toBe(0)
  })

  it.each([
    ['segreteria', segreteria],
    ['coordinator', dirigente],
    ['admin', { id: DIRIGENTE, role: 'admin' } as AppUser],
  ])('%s può sulle voci altrui', async (_n, utente) => {
    expect(await verificaPermessoVoce(client(), utente, voce(), ADESSO)).toEqual({ ok: true })
  })

  it('i ruoli REALI contano, non la veste: un genitore che è anche segreteria può', async () => {
    const doppio: AppUser = { id: SEGRETERIA, role: 'genitore', ruoli: ['genitore', 'segreteria'] }
    expect(await verificaPermessoVoce(client(), doppio, voce(), ADESSO)).toEqual({ ok: true })
  })

  it('una voce senza autore noto resta solo allo staff', async () => {
    const senza = voce({ autoreId: null })
    expect((await verificaPermessoVoce(client(), maestra, senza, ADESSO)).ok).toBe(false)
    expect((await verificaPermessoVoce(client(), segreteria, senza, ADESSO)).ok).toBe(true)
  })
})

describe('CHI — l’impreparato dichiarato dal GENITORE', () => {
  const dalGenitore = (extra: Partial<VocePrimaria> = {}) =>
    voce({ tipo: 'impreparato', origine: 'genitore', autoreId: 'fa311100-0000-4000-8000-000000000009', ...extra })

  it('lo toglie QUALUNQUE docente della classe', async () => {
    expect(await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO)).toEqual({ ok: true })
    expect(tabelle).toContain('utenti_sezioni')
  })

  it('NON una docente di un’altra classe', async () => {
    const esito = await verificaPermessoVoce(client(), estranea, dalGenitore(), ADESSO)
    expect(esito).toEqual({ ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' })
  })

  it('l’impreparato segnato da una DOCENTE resta dell’autrice (la collega no)', async () => {
    const delDocente = voce({ tipo: 'impreparato', origine: 'docente', autoreId: MAESTRA })
    expect((await verificaPermessoVoce(client(), collega, delDocente, ADESSO)).ok).toBe(false)
    expect(tabelle).not.toContain('utenti_sezioni')
  })

  it('la deroga è dei soli impreparati: una nota altrui resta negata alla collega', async () => {
    const nota = voce({ tipo: 'nota', origine: 'genitore', autoreId: MAESTRA })
    expect((await verificaPermessoVoce(client(), collega, nota, ADESSO)).ok).toBe(false)
  })

  it('un guasto su `utenti_sezioni` è 500 LETTURA_FALLITA, non un 403', async () => {
    opzioni = { errori: { 'utenti_sezioni:select': { code: '57014', message: 'timeout' } } }
    const esito = await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO)
    expect(esito).toEqual({ ok: false, stato: 500, codice: 'LETTURA_FALLITA' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'error', expect.objectContaining({ esito: 'docenti-classe-non-letti' }), expect.anything(),
    )
  })
})

describe('FINO A QUANDO — il termine vale per tutti', () => {
  it('oltre i 2 giorni l’autore prende 423 VOCE_BLOCCATA col limite', async () => {
    const esito = await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI }), ADESSO)
    expect(esito).toEqual({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2 })
  })

  it('anche la Direzione e la Segreteria sono fermate dal termine', async () => {
    for (const u of [dirigente, segreteria]) {
      const esito = await verificaPermessoVoce(client(), u, voce({ dataEvento: LUNEDI }), ADESSO)
      expect(esito.ok).toBe(false)
      expect(esito).toMatchObject({ stato: 423 })
    }
  })

  it('il secondo giorno è ancora buono', async () => {
    expect((await verificaPermessoVoce(client(), maestra, voce({ dataEvento: MARTEDI }), ADESSO)).ok).toBe(true)
  })

  it('le prove scritte/pratiche hanno 15 giorni', async () => {
    const scritta = voce({ dataEvento: '2026-08-27', lockTipo: 'scritto_pratico' }) // 14 giorni
    expect((await verificaPermessoVoce(client(), maestra, scritta, ADESSO)).ok).toBe(true)
    const vecchia = voce({ dataEvento: '2026-08-25', lockTipo: 'scritto_pratico' }) // 16 giorni
    expect(await verificaPermessoVoce(client(), maestra, vecchia, ADESSO)).toMatchObject({ stato: 423, giorniLimite: 15 })
  })

  it('i giorni sono quelli della SEDE (admin_settings)', async () => {
    db.admin_settings = [{ scuola_id: SEDE_A, timelock_giorni_classe_orale: 5, timelock_giorni_scritto_pratico: 15 }]
    expect((await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI }), ADESSO)).ok).toBe(true)
  })

  it('«oggi» è il giorno di ROMA: alle 00:30 del 10/09 il lunedì 07/09 è già oltre', async () => {
    const mezzanotteEMezza = new Date('2026-09-09T22:30:00Z')
    const esito = await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI }), mezzanotteEMezza)
    expect(esito).toMatchObject({ stato: 423 })
  })

  it('se la modifica SPOSTA la data, si controllano entrambe', async () => {
    // Dalla data di ieri (buona) a lunedì (oltre): bloccata.
    const verso = voce({ dataEvento: IERI, nuovaDataEvento: LUNEDI })
    expect(await verificaPermessoVoce(client(), maestra, verso, ADESSO)).toMatchObject({ stato: 423 })
    // Da lunedì (oltre) a ieri: bloccata lo stesso.
    const da = voce({ dataEvento: LUNEDI, nuovaDataEvento: IERI })
    expect(await verificaPermessoVoce(client(), maestra, da, ADESSO)).toMatchObject({ stato: 423 })
  })

  it('un guasto su `admin_settings` è 500 LETTURA_FALLITA', async () => {
    opzioni = { errori: { admin_settings: { code: '57014', message: 'timeout' } } }
    expect(await verificaPermessoVoce(client(), maestra, voce(), ADESSO)).toEqual({
      ok: false, stato: 500, codice: 'LETTURA_FALLITA',
    })
  })
})

describe('OLTRE IL TERMINE — lo sblocco della Direzione', () => {
  const oltre = (extra: Partial<VocePrimaria> = {}) => voce({ dataEvento: LUNEDI, ...extra })

  it('lo sblocco della VOCE (stesso tipo e id) riapre', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1 }]
    expect(await verificaPermessoVoce(client(), maestra, oltre(), ADESSO)).toEqual({ ok: true })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-oltre-termine-autorizzata', azione: 'voce' }),
    )
  })

  it('lo sblocco di un ALTRO tipo con lo stesso id non vale', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'nota', entita_id: VOCE_1 }]
    expect(await verificaPermessoVoce(client(), maestra, oltre(), ADESSO)).toMatchObject({ stato: 423 })
  })

  it('lo sblocco del GIORNO della classe riapre ogni voce di quel giorno', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: LUNEDI, ora_lezione: null }]
    for (const tipo of ['valutazione', 'nota', 'impreparato', 'allegato', 'firma', 'registro'] as const) {
      expect(await verificaPermessoVoce(client(), maestra, oltre({ tipo }), ADESSO), tipo).toEqual({ ok: true })
    }
  })

  it('il giorno di un’ALTRA classe, o di un altro giorno, non vale', async () => {
    db.sblocchi_audit = [
      { id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_B, data: LUNEDI },
      { id: 's2', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: MARTEDI },
    ]
    expect(await verificaPermessoVoce(client(), maestra, oltre(), ADESSO)).toMatchObject({ stato: 423 })
  })

  it('registro e firma si riaprono anche con lo sblocco dello SLOT (stessa ora)', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'registro', entita_id: null, section_id: SEZ_A, data: LUNEDI, ora_lezione: 3 }]
    expect(await verificaPermessoVoce(client(), maestra, oltre({ tipo: 'firma', oraLezione: 3 }), ADESSO)).toEqual({ ok: true })
    expect(await verificaPermessoVoce(client(), maestra, oltre({ tipo: 'registro', oraLezione: 3 }), ADESSO)).toEqual({ ok: true })
    // Un'altra ora dello stesso giorno: no.
    expect(await verificaPermessoVoce(client(), maestra, oltre({ tipo: 'firma', oraLezione: 4 }), ADESSO)).toMatchObject({ stato: 423 })
    // Lo slot NON sblocca le voci che non sono registro o firma.
    expect(await verificaPermessoVoce(client(), maestra, oltre({ tipo: 'allegato', oraLezione: 3 }), ADESSO)).toMatchObject({ stato: 423 })
  })

  it('data spostata: ogni data oltre il termine va sbloccata', async () => {
    const spostata = voce({ dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04' })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', section_id: SEZ_A, data: LUNEDI }]
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toMatchObject({ stato: 423 })
    db.sblocchi_audit.push({ id: 's2', entita_tipo: 'giorno', section_id: SEZ_A, data: '2026-09-04' })
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toEqual({ ok: true })
  })

  it('lo sblocco della VOCE copre solo la sua data: spostarla su un’altra data oltre il termine chiede lo sblocco di quel giorno', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1 }]
    const spostata = voce({ dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04' })
    // Solo lo sblocco della voce: la nuova data resta scoperta.
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2,
    })
    // Lo sblocco del giorno di un'ALTRA classe non copre la nuova data.
    db.sblocchi_audit.push({ id: 's2', entita_tipo: 'giorno', section_id: SEZ_B, data: '2026-09-04' })
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toMatchObject({ stato: 423 })
    // Con lo sblocco del giorno 04/09 della classe: ok.
    db.sblocchi_audit.push({ id: 's3', entita_tipo: 'giorno', section_id: SEZ_A, data: '2026-09-04' })
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toEqual({ ok: true })
  })

  it('lo sblocco della VOCE e una nuova data ENTRO il termine: ok senza altro sblocco', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1 }]
    const spostata = voce({ dataEvento: LUNEDI, nuovaDataEvento: IERI })
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toEqual({ ok: true })
  })

  it('firma sbloccata per voce spostata su un’altra data: basta lo SLOT di quella data', async () => {
    db.sblocchi_audit = [
      { id: 's1', entita_tipo: 'firma', entita_id: VOCE_1 },
      { id: 's2', entita_tipo: 'registro', entita_id: null, section_id: SEZ_A, data: '2026-09-04', ora_lezione: 2 },
    ]
    const firma = (ora: number) =>
      voce({ tipo: 'firma', dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04', oraLezione: ora })
    expect(await verificaPermessoVoce(client(), maestra, firma(2), ADESSO)).toEqual({ ok: true })
    expect(await verificaPermessoVoce(client(), maestra, firma(5), ADESSO)).toMatchObject({ stato: 423 })
  })

  it('statoVoci: una voce sbloccata per voce ma spostata su una data scoperta resta bloccata', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1 }]
    const r = await statoVoci(
      client(), maestra, [voce({ dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04' })], ADESSO,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual({ modificabile: false, bloccata: true, giorniLimite: 2 })
  })

  it('lo sblocco NON scavalca il CHI: una collega resta 403 anche su una voce sbloccata', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1 }]
    expect(await verificaPermessoVoce(client(), collega, oltre(), ADESSO)).toMatchObject({ stato: 403 })
  })

  it('un guasto nella lettura degli sblocchi è 500, mai un 423 travestito', async () => {
    opzioni = { errori: { 'sblocchi_audit:select': { code: '57014', message: 'timeout' } } }
    expect(await verificaPermessoVoce(client(), maestra, oltre(), ADESSO)).toEqual({
      ok: false, stato: 500, codice: 'LETTURA_FALLITA',
    })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'error', expect.objectContaining({ esito: 'sblocchi-per-voce-non-letti' }), expect.anything(),
    )
  })

  it('DB non migrato (42703 sulle colonne del giorno): degrada a «nessuno sblocco per giorno», dichiarato', async () => {
    senzaColonneGiorno = true
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', section_id: SEZ_A, data: LUNEDI }]
    expect(await verificaPermessoVoce(client(), maestra, oltre(), ADESSO)).toMatchObject({ stato: 423 })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'sblocco-per-giorno-non-disponibile-schema' }), expect.anything(),
    )
    // Lo sblocco per VOCE resta leggibile anche lì.
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'valutazione', entita_id: VOCE_1 }]
    expect(await verificaPermessoVoce(client(), maestra, oltre(), ADESSO)).toEqual({ ok: true })
  })
})

describe('statoVoci — la variante per gli elenchi', () => {
  it('dice per ogni voce se è modificabile e se è bloccata', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', section_id: SEZ_A, data: '2026-09-04' }]
    const voci: VocePrimaria[] = [
      voce({ id: VOCE_1, dataEvento: IERI }), // mia, entro
      voce({ id: VOCE_2, dataEvento: LUNEDI }), // mia, oltre, senza sblocco
      voce({ id: VOCE_3, dataEvento: '2026-09-04', autoreId: COLLEGA }), // altrui, oltre, giorno sbloccato
    ]
    const r = await statoVoci(client(), maestra, voci, ADESSO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual({ modificabile: true, bloccata: false, giorniLimite: 2 })
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual({ modificabile: false, bloccata: true, giorniLimite: 2 })
    // Sbloccata, ma non è mia: non modificabile, e nemmeno «bloccata».
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_3))).toEqual({ modificabile: false, bloccata: false, giorniLimite: 2 })
  })

  it('poche query per tutto il lotto: termini una volta per sede, sblocchi al più due', async () => {
    const voci = Array.from({ length: 12 }, (_, i) =>
      voce({ id: `e9157200-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, dataEvento: i % 2 ? LUNEDI : IERI }),
    )
    const r = await statoVoci(client(), dirigente, voci, ADESSO)
    expect(r.ok).toBe(true)
    expect(tabelle.filter((t) => t === 'admin_settings')).toHaveLength(1)
    expect(letturaSblocchi()).toBeLessThanOrEqual(2)
    if (r.ok) {
      expect([...r.esiti.values()].filter((e) => e.bloccata)).toHaveLength(6)
      // La Direzione vede il blocco (per mostrare «Sblocca»), non la modifica.
      expect([...r.esiti.values()].filter((e) => e.modificabile)).toHaveLength(6)
    }
  })

  it('lotto su DUE classi: il giorno sbloccato di una non riapre l’altra', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', section_id: SEZ_B, data: LUNEDI }]
    const voci = [
      voce({ id: VOCE_1, sectionId: SEZ_A, dataEvento: LUNEDI }),
      voce({ id: VOCE_2, sectionId: SEZ_B, dataEvento: LUNEDI }),
    ]
    const r = await statoVoci(client(), dirigente, voci, ADESSO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toMatchObject({ bloccata: true, modificabile: false })
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_2))).toMatchObject({ bloccata: false, modificabile: true })
  })

  it('un lotto vuoto non legge niente', async () => {
    const r = await statoVoci(client(), maestra, [], ADESSO)
    expect(r).toEqual({ ok: true, esiti: new Map() })
    expect(tabelle).toHaveLength(0)
  })

  it('un guasto si propaga come LETTURA_FALLITA per tutto il lotto', async () => {
    opzioni = { errori: { 'sblocchi_audit:select': { code: '57014', message: 'timeout' } } }
    const r = await statoVoci(client(), maestra, [voce({ dataEvento: LUNEDI })], ADESSO)
    expect(r).toEqual({ ok: false, stato: 500, codice: 'LETTURA_FALLITA' })
  })
})

describe('contorno', () => {
  it('dataEventoDaIstante: la data di Roma di `creato_il`', () => {
    expect(dataEventoDaIstante('2026-09-06T22:30:00Z')).toBe('2026-09-07')
  })

  it('rispostaPermessoNegato: stato e codice stabili, nessuna prosa di PostgREST', async () => {
    const r403 = rispostaPermessoNegato({ ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' })
    expect(r403.status).toBe(403)
    expect(await r403.json()).toMatchObject({ codice: 'VOCE_NON_AUTORE' })

    const r423 = rispostaPermessoNegato({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 15 })
    expect(r423.status).toBe(423)
    const c423 = await r423.json()
    expect(c423).toMatchObject({ codice: 'VOCE_BLOCCATA', giorniLimite: 15, locked: true })
    expect(c423.error).toContain('15 giorni')

    const r500 = rispostaPermessoNegato({ ok: false, stato: 500, codice: 'LETTURA_FALLITA' })
    expect(r500.status).toBe(500)
    expect(await r500.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
  })
})
