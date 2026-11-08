import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
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
  contaDalSalvataggio,
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
const VOCE_4 = 'e9157200-0000-4000-8000-000000000004'
const P_ESTATE = '9e710001-0000-4000-8000-0000000000e1'
const P1 = '9e710002-0000-4000-8000-0000000000e2'
const P1_SEDE_B = '9e710003-0000-4000-8000-0000000000e3'

/** 12:00 del 10/09/2026 a Roma. */
const ADESSO = new Date('2026-09-10T10:00:00Z')
const IERI = '2026-09-09' // 1 giorno: entro il termine di 2
const LUNEDI = '2026-09-07' // 3 giorni: oltre il termine di 2
const MARTEDI = '2026-09-08' // 2 giorni: ancora entro
const VENERDI = '2026-09-04' // 6 giorni: oltre
const ESTATE = '2026-06-15' // nel periodo estivo (P_ESTATE), il cui scrutinio si chiude nei test di congelamento
/** Lo scrutinio dell'estate è chiuso il 31/08: la sua riga porta `chiuso_il`, ed è da lì che uno sblocco «vale» o no. */
const CHIUSO_IL = '2026-08-31T18:00:00Z'
/** Uno sblocco dato PRIMA di quella chiusura (per tutt'altro motivo) e uno dato DOPO. */
const SBLOCCO_PRIMA = '2026-07-15T09:00:00Z'
const SBLOCCO_DOPO = '2026-09-02T09:00:00Z'

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
    scrutinio_periodi: [],
    scrutini: [],
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

  describe('solo le sezioni dell’anno attivo (4.3.6): è un controllo di SCRITTURA', () => {
    const conFunzione = (data: unknown, error: unknown = null) => {
      opzioni = { rpc: { sezioni_visibili_docente: () => ({ data, error }) } as never }
    }

    it('la sezione dell’anno attivo passa', async () => {
      conFunzione([{ section_id: SEZ_A, sola_lettura: false }])
      expect(await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO)).toEqual({ ok: true })
    })

    it('una sezione che la funzione non restituisce (anno in preparazione) NON passa', async () => {
      conFunzione([])
      expect(await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO))
        .toEqual({ ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' })
    })

    it('una sezione in sola lettura (anno passato) NON passa: non si scrive sul registro vecchio', async () => {
      conFunzione([{ section_id: SEZ_A, sola_lettura: true }])
      expect(await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO))
        .toEqual({ ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' })
    })

    it('un guasto della funzione è 500 LETTURA_FALLITA come oggi', async () => {
      conFunzione(null, { code: '57014', message: 'timeout' })
      expect(await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO))
        .toEqual({ ok: false, stato: 500, codice: 'LETTURA_FALLITA' })
    })
  })

  it('un guasto su `utenti_sezioni` è 500 LETTURA_FALLITA, non un 403', async () => {
    opzioni = { errori: { 'utenti_sezioni:select': { code: '57014', message: 'timeout' } } }
    const esito = await verificaPermessoVoce(client(), collega, dalGenitore(), ADESSO)
    expect(esito).toEqual({ ok: false, stato: 500, codice: 'LETTURA_FALLITA' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'error', expect.objectContaining({ esito: 'sezioni-non-lette' }), expect.anything(),
    )
  })
})

describe('FINO A QUANDO — il termine vale per i docenti', () => {
  it('oltre i 2 giorni l’autore prende 423 VOCE_BLOCCATA col limite', async () => {
    const esito = await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI }), ADESSO)
    expect(esito).toEqual({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2 })
  })

  it('Direzione e Segreteria correggono lo storico senza termini e senza query sblocchi', async () => {
    for (const u of [dirigente, segreteria]) {
      const esito = await verificaPermessoVoce(client(), u, voce({ dataEvento: LUNEDI }), ADESSO)
      expect(esito.ok).toBe(true)
      expect(tabelle).not.toContain('sblocchi_audit')
      expect(tabelle).not.toContain('admin_settings')
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

  // Le NOTE: per loro il termine conta ancora sulle date dell'evento (valutazioni e
  // impreparati della docente contano dal salvataggio: vedi «TERMINE DAL SALVATAGGIO»).
  it('se la modifica SPOSTA la data, si controllano entrambe', async () => {
    // Dalla data di ieri (buona) a lunedì (oltre): bloccata.
    const verso = voce({ tipo: 'nota', dataEvento: IERI, nuovaDataEvento: LUNEDI })
    expect(await verificaPermessoVoce(client(), maestra, verso, ADESSO)).toMatchObject({ stato: 423 })
    // Da lunedì (oltre) a ieri: bloccata lo stesso.
    const da = voce({ tipo: 'nota', dataEvento: LUNEDI, nuovaDataEvento: IERI })
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
    const spostata = voce({ tipo: 'nota', dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04' })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', section_id: SEZ_A, data: LUNEDI }]
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toMatchObject({ stato: 423 })
    db.sblocchi_audit.push({ id: 's2', entita_tipo: 'giorno', section_id: SEZ_A, data: '2026-09-04' })
    expect(await verificaPermessoVoce(client(), maestra, spostata, ADESSO)).toEqual({ ok: true })
  })

  it('lo sblocco della VOCE copre solo la sua data: spostarla su un’altra data oltre il termine chiede lo sblocco di quel giorno', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'nota', entita_id: VOCE_1 }]
    const spostata = voce({ tipo: 'nota', dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04' })
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
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'nota', entita_id: VOCE_1 }]
    const r = await statoVoci(
      client(), maestra, [voce({ tipo: 'nota', dataEvento: LUNEDI, nuovaDataEvento: '2026-09-04' })], ADESSO,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('nota', VOCE_1))).toEqual({ modificabile: false, bloccata: true, giorniLimite: 2 })
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
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual({ modificabile: true, bloccata: false, congelata: false, giorniLimite: 2 })
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual({ modificabile: false, bloccata: true, congelata: false, giorniLimite: 2 })
    // Sbloccata, ma non è mia: non modificabile, e nemmeno «bloccata».
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_3))).toEqual({ modificabile: false, bloccata: false, congelata: false, giorniLimite: 2 })
  })

  it('poche query per tutto il lotto: termini una volta per sede, sblocchi al più due', async () => {
    const voci = Array.from({ length: 12 }, (_, i) =>
      voce({ id: `e9157200-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, dataEvento: i % 2 ? LUNEDI : IERI }),
    )
    const r = await statoVoci(client(), maestra, voci, ADESSO)
    expect(r.ok).toBe(true)
    expect(tabelle.filter((t) => t === 'admin_settings')).toHaveLength(1)
    expect(letturaSblocchi()).toBeLessThanOrEqual(2)
    if (r.ok) {
      expect([...r.esiti.values()].filter((e) => e.bloccata)).toHaveLength(6)
      // Il docente continua a vedere il blocco sulle sei voci oltre il termine.
      expect([...r.esiti.values()].filter((e) => e.modificabile)).toHaveLength(6)
    }
  })

  it('lotto su DUE classi: il giorno sbloccato di una non riapre l’altra', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', section_id: SEZ_B, data: LUNEDI }]
    const voci = [
      voce({ id: VOCE_1, sectionId: SEZ_A, dataEvento: LUNEDI }),
      voce({ id: VOCE_2, sectionId: SEZ_B, dataEvento: LUNEDI }),
    ]
    const r = await statoVoci(client(), maestra, voci, ADESSO)
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

describe('TERMINE DAL SALVATAGGIO — valutazioni e impreparati della docente', () => {
  it('contaDalSalvataggio: la valutazione e l’impreparato NON del genitore', () => {
    expect(contaDalSalvataggio(voce({ tipo: 'valutazione' }))).toBe(true)
    expect(contaDalSalvataggio(voce({ tipo: 'impreparato', origine: 'docente' }))).toBe(true)
    expect(contaDalSalvataggio(voce({ tipo: 'impreparato' }))).toBe(true)
    expect(contaDalSalvataggio(voce({ tipo: 'impreparato', origine: 'genitore' }))).toBe(false)
    for (const tipo of ['nota', 'registro', 'firma', 'allegato'] as const) {
      expect(contaDalSalvataggio(voce({ tipo })), tipo).toBe(false)
    }
  })

  it('retrodatato di tre settimane, salvato ieri: si modifica', async () => {
    const v = voce({ dataEvento: '2026-08-20', giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('datato ieri ma salvato tre giorni fa: 423 VOCE_BLOCCATA 2', async () => {
    const v = voce({ dataEvento: IERI, giornoSalvataggio: LUNEDI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2,
    })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-bloccata', error_code: 'VOCE_BLOCCATA' }),
    )
  })

  it('impreparato della docente: stesse due regole', async () => {
    const impreparato = (extra: Partial<VocePrimaria>) => voce({ tipo: 'impreparato', origine: 'docente', ...extra })
    expect(
      await verificaPermessoVoce(client(), maestra, impreparato({ dataEvento: '2026-08-20', giornoSalvataggio: IERI }), ADESSO),
    ).toEqual({ ok: true })
    expect(
      await verificaPermessoVoce(client(), maestra, impreparato({ dataEvento: IERI, giornoSalvataggio: LUNEDI }), ADESSO),
    ).toEqual({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2 })
  })

  it('senza giornoSalvataggio si usa dataEvento', async () => {
    expect(await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI }), ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2,
    })
    expect(await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI, giornoSalvataggio: null }), ADESSO))
      .toMatchObject({ stato: 423, codice: 'VOCE_BLOCCATA' })
    expect(await verificaPermessoVoce(client(), maestra, voce({ dataEvento: IERI }), ADESSO)).toEqual({ ok: true })
  })

  it('impreparato del genitore: flusso di prima, periodi mai letti', async () => {
    const dalGenitore = (extra: Partial<VocePrimaria>) =>
      voce({ tipo: 'impreparato', origine: 'genitore', autoreId: 'fa311100-0000-4000-8000-000000000009', ...extra })
    // Il termine conta sulla data dell'evento (lunedì), non sul salvataggio (ieri): la collega prende 423.
    expect(
      await verificaPermessoVoce(client(), collega, dalGenitore({ dataEvento: LUNEDI, giornoSalvataggio: IERI }), ADESSO),
    ).toMatchObject({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA' })
    // E all'inverso passa: ieri per la data, lunedì per il salvataggio che qui non conta.
    expect(
      await verificaPermessoVoce(client(), collega, dalGenitore({ dataEvento: IERI, giornoSalvataggio: LUNEDI }), ADESSO),
    ).toEqual({ ok: true })
    expect(tabelle).not.toContain('scrutinio_periodi')
    expect(tabelle).not.toContain('scrutini')
  })

  it.each(['nota', 'registro', 'firma', 'allegato'] as const)(
    '%s: termine sulla data dell’evento, giornoSalvataggio ignorato',
    async (tipo) => {
      expect(
        await verificaPermessoVoce(client(), maestra, voce({ tipo, dataEvento: LUNEDI, giornoSalvataggio: IERI }), ADESSO),
      ).toMatchObject({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA' })
      expect(
        await verificaPermessoVoce(client(), maestra, voce({ tipo, dataEvento: IERI, giornoSalvataggio: LUNEDI }), ADESSO),
      ).toEqual({ ok: true })
      expect(tabelle).not.toContain('scrutinio_periodi')
      expect(tabelle).not.toContain('scrutini')
    },
  )

  it('sblocco del giorno: conta il giorno del salvataggio, non quello della prova', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: LUNEDI }]
    // Salvata lunedì, prova del 1° settembre: lo sblocco di lunedì la riapre.
    expect(
      await verificaPermessoVoce(client(), maestra, voce({ dataEvento: '2026-09-01', giornoSalvataggio: LUNEDI }), ADESSO),
    ).toEqual({ ok: true })
    // Prova di lunedì ma salvata il 4/9: lo sblocco di lunedì non c'entra.
    expect(
      await verificaPermessoVoce(client(), maestra, voce({ dataEvento: LUNEDI, giornoSalvataggio: VENERDI }), ADESSO),
    ).toMatchObject({ ok: false, stato: 423, codice: 'VOCE_BLOCCATA' })
  })

  it('statoVoci: il termine conta dal salvataggio, lo sblocco del giorno è quello del salvataggio', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: LUNEDI }]
    const r = await statoVoci(
      client(),
      maestra,
      [
        voce({ id: VOCE_1, dataEvento: '2026-08-20', giornoSalvataggio: IERI }), // vecchia ma salvata ieri
        voce({ id: VOCE_2, dataEvento: IERI, giornoSalvataggio: VENERDI }), // recente ma salvata il 4/9
        voce({ id: VOCE_3, dataEvento: '2026-09-01', giornoSalvataggio: LUNEDI }), // salvata lunedì, giorno sbloccato
      ],
      ADESSO,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual({ modificabile: true, bloccata: false, congelata: false, giorniLimite: 2 })
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual({ modificabile: false, bloccata: true, congelata: false, giorniLimite: 2 })
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_3))).toEqual({ modificabile: true, bloccata: false, congelata: false, giorniLimite: 2 })
  })
})

describe('CONGELAMENTO — scrutinio chiuso', () => {
  const periodo = (extra: Record<string, unknown>) => ({
    scuola_id: SEDE_A, nome: 'Quadrimestre', attivo: true, ...extra,
  })
  beforeEach(() => {
    db.scrutinio_periodi = [
      periodo({ id: P_ESTATE, anno_scolastico: '2025/2026', ordine: 2, data_inizio: '2026-06-01', data_fine: '2026-08-31' }),
      periodo({ id: P1, anno_scolastico: '2026/2027', ordine: 1, data_inizio: '2026-09-01', data_fine: '2027-01-31' }),
    ]
    // Chiuso lo scrutinio del periodo estivo per SEZ_A; quello di P1 è aperto (nessuna riga).
    db.scrutini = [{ id: 'sc1', section_id: SEZ_A, periodo_id: P_ESTATE, stato: 'chiuso', chiuso_il: CHIUSO_IL }]
  })

  it('quadrimestre chiuso: 423 QUADRIMESTRE_CHIUSO anche dentro il termine', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-congelata', error_code: 'QUADRIMESTRE_CHIUSO' }),
    )
    expect(h.logEvento).not.toHaveBeenCalledWith('registro', 'info', expect.objectContaining({ esito: 'voce-bloccata' }))
  })

  it('congelata E oltre il termine: vince QUADRIMESTRE_CHIUSO', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: LUNEDI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
  })

  it('l’impreparato della docente si congela come la valutazione', async () => {
    const v = voce({ tipo: 'impreparato', origine: 'docente', dataEvento: ESTATE, giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toMatchObject({ stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
  })

  it('un quadrimestre APERTO non congela: P1 dentro il termine passa', async () => {
    const v = voce({ dataEvento: '2026-09-02', giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
    expect(letturaSblocchi()).toBe(0)
  })

  it.each([
    ['da aperto a chiuso', IERI, ESTATE],
    ['da chiuso ad aperto', ESTATE, IERI],
  ])('spostare %s: 423 QUADRIMESTRE_CHIUSO', async (_nome, dataEvento, nuovaDataEvento) => {
    const v = voce({ dataEvento, nuovaDataEvento, giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
  })

  it('uno sblocco per voce riapre termine e congelamento, anche spostando la data', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    // Evento e nuova data stanno tutte e due nel periodo chiuso, e il salvataggio è oltre il termine.
    const v = voce({ dataEvento: ESTATE, nuovaDataEvento: '2026-06-10', giornoSalvataggio: '2026-08-01' })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-congelata-autorizzata', azione: 'voce' }),
    )
    expect(h.logEvento).not.toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-oltre-termine-autorizzata' }),
    )
    // Anche da un quadrimestre aperto a uno chiuso, salvata ieri (dentro il termine): la voce è sbloccata, vale tutto.
    const verso = voce({ dataEvento: IERI, nuovaDataEvento: ESTATE, giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, verso, ADESSO)).toEqual({ ok: true })
  })

  it('lo sblocco del giorno del salvataggio riapre anche il congelamento', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: '2026-08-01' })
    // Lo sblocco del giorno della PROVA non basta: conta il giorno in cui il voto è stato salvato.
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: ESTATE, sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toMatchObject({ stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
    // Quello della classe giusta e del giorno del salvataggio sì.
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-08-01', sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-congelata-autorizzata', azione: 'giorno' }),
    )
    // Lo sblocco del giorno di un'ALTRA classe no.
    db.sblocchi_audit = [{ id: 's3', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_B, data: '2026-08-01', sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toMatchObject({ stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
  })

  // ── Uno sblocco riapre una voce CONGELATA solo se è dato DOPO la chiusura che la congela ───────────
  // Il filtro di tempo vale per il congelamento e basta: il termine (2/15 giorni) e le voci che non si
  // congelano restano come prima, con qualunque sblocco.

  it('sblocco per VOCE dato PRIMA della chiusura: non scongela; dato DOPO sì', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: IERI })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'voce-congelata', error_code: 'QUADRIMESTRE_CHIUSO' }),
    )
    db.sblocchi_audit.push({ id: 's2', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('sblocco del GIORNO del salvataggio dato PRIMA della chiusura: non scongela; dato DOPO sì', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: '2026-08-01' })
    db.sblocchi_audit = [
      { id: 's1', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-08-01', sbloccato_il: SBLOCCO_PRIMA },
    ]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
    db.sblocchi_audit = [
      { id: 's2', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-08-01', sbloccato_il: SBLOCCO_DOPO },
    ]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it.each([
    ['da aperto a chiuso', IERI, ESTATE],
    ['da chiuso ad aperto', ESTATE, IERI],
  ])('spostare %s con uno sblocco VECCHIO: 423; con uno nuovo: ok', async (_nome, dataEvento, nuovaDataEvento) => {
    const v = voce({ dataEvento, nuovaDataEvento, giornoSalvataggio: IERI })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('due quadrimestri chiusi (data attuale e data nuova): ognuno chiede uno sblocco dopo la PROPRIA chiusura', async () => {
    // P1 chiude il 09/09, dopo l'estate: lo sblocco del 02/09 è dopo la prima chiusura e prima della seconda.
    db.scrutini.push({ id: 'sc2', section_id: SEZ_A, periodo_id: P1, stato: 'chiuso', chiuso_il: '2026-09-09T08:00:00Z' })
    const v = voce({ dataEvento: ESTATE, nuovaDataEvento: IERI, giornoSalvataggio: IERI })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toMatchObject({ stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: '2026-09-09T09:00:00Z' }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('congelata E oltre il termine: serve comunque uno sblocco dopo la chiusura', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: LUNEDI })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toMatchObject({ stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('l’impreparato della docente: stesso filtro del voto', async () => {
    const v = voce({ tipo: 'impreparato', origine: 'docente', dataEvento: ESTATE, giornoSalvataggio: IERI })
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'impreparato', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toMatchObject({ stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'impreparato', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('uno sblocco senza `sbloccato_il`, o con una data illeggibile, non scongela mai', async () => {
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: IERI })
    for (const sbloccato_il of [null, 'ieri mattina']) {
      db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il }]
      expect(await verificaPermessoVoce(client(), maestra, v, ADESSO), String(sbloccato_il)).toMatchObject({
        stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
      })
    }
  })

  it('una chiusura senza `chiuso_il`: nessuno sblocco la supera (fail-closed), senza leggerli, e lo dice a livello info', async () => {
    db.scrutini = [{ id: 'sc1', section_id: SEZ_A, periodo_id: P_ESTATE, stato: 'chiuso', chiuso_il: null }]
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    const v = voce({ dataEvento: ESTATE, giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({
      ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO',
    })
    expect(letturaSblocchi()).toBe(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'scrutinio-chiuso-senza-data', sezione: SEZ_A }),
    )
    // Lo staff modifica comunque, senza guardare niente.
    expect(await verificaPermessoVoce(client(), segreteria, v, ADESSO)).toEqual({ ok: true })
  })

  it('il termine non cambia: fuori da un quadrimestre chiuso qualunque sblocco, anche vecchio, riapre', async () => {
    // Valutazione in P1 (aperto), salvata lunedì (oltre il termine): lo sblocco di luglio basta.
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA }]
    expect(
      await verificaPermessoVoce(client(), maestra, voce({ dataEvento: '2026-09-02', giornoSalvataggio: LUNEDI }), ADESSO),
    ).toEqual({ ok: true })
    // Una nota nel periodo chiuso non si congela mai: oltre il termine basta uno sblocco senza data.
    db.sblocchi_audit = [{ id: 's2', entita_tipo: 'nota', entita_id: VOCE_1 }]
    expect(await verificaPermessoVoce(client(), maestra, voce({ tipo: 'nota', dataEvento: ESTATE }), ADESSO)).toEqual({ ok: true })
  })

  it('legge `sbloccato_il` dagli sblocchi e `chiuso_il` dagli scrutini', async () => {
    const colonne: Record<string, string[]> = {}
    const vero = client() as unknown as { from: (t: string) => Record<string, unknown> }
    const spia = {
      from(tabella: string) {
        const qb = vero.from(tabella)
        const selectVero = qb.select as (c: string) => unknown
        qb.select = (c: string) => {
          ;(colonne[tabella] ??= []).push(c)
          return selectVero.call(qb, c)
        }
        return qb
      },
    } as unknown as SupabaseClient
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA }]
    await verificaPermessoVoce(spia, maestra, voce({ dataEvento: ESTATE, giornoSalvataggio: IERI }), ADESSO)
    expect(colonne.scrutini).toHaveLength(1)
    expect(colonne.scrutini[0]).toContain('chiuso_il')
    // Uno sblocco per voce non basta (è vecchio): si legge anche per giorno, e tutte e due le letture portano la data.
    expect(colonne.sblocchi_audit).toHaveLength(2)
    for (const c of colonne.sblocchi_audit) expect(c).toContain('sbloccato_il')
  })

  it('un’altra classe non è congelata dallo scrutinio di SEZ_A', async () => {
    const v = voce({ sectionId: SEZ_B, dataEvento: ESTATE, giornoSalvataggio: IERI })
    expect(await verificaPermessoVoce(client(), maestra, v, ADESSO)).toEqual({ ok: true })
  })

  it('le voci che non contano dal salvataggio non si congelano e non leggono i periodi', async () => {
    for (const v of [
      voce({ tipo: 'nota', dataEvento: ESTATE }),
      voce({ tipo: 'impreparato', origine: 'genitore', autoreId: MAESTRA, dataEvento: ESTATE }),
    ]) {
      // Fuori dal termine ma NON congelate: serve lo sblocco, e l'errore è quello di sempre.
      expect(await verificaPermessoVoce(client(), maestra, v, ADESSO), v.tipo).toMatchObject({ codice: 'VOCE_BLOCCATA' })
    }
    expect(tabelle).not.toContain('scrutinio_periodi')
    expect(tabelle).not.toContain('scrutini')
  })

  it('lo staff passa senza leggere periodi né scrutini', async () => {
    for (const u of [segreteria, dirigente]) {
      expect(await verificaPermessoVoce(client(), u, voce({ dataEvento: ESTATE, giornoSalvataggio: LUNEDI }), ADESSO))
        .toEqual({ ok: true })
    }
    expect(tabelle).not.toContain('scrutinio_periodi')
    expect(tabelle).not.toContain('scrutini')
  })

  it('guasto su scrutinio_periodi o scrutini: 500 LETTURA_FALLITA', async () => {
    const v = voce({ dataEvento: IERI, giornoSalvataggio: IERI })
    for (const chiave of ['scrutinio_periodi:select', 'scrutini:select']) {
      h.logEvento.mockClear()
      opzioni = { errori: { [chiave]: { code: '57014', message: 'timeout' } } }
      expect(await verificaPermessoVoce(client(), maestra, v, ADESSO), chiave).toEqual({
        ok: false, stato: 500, codice: 'LETTURA_FALLITA',
      })
      // Mai un 423 né un'autorizzazione inventati, e nessuna lettura di sblocchi che non si sa a cosa servano.
      expect(h.logEvento).not.toHaveBeenCalledWith('registro', 'info', expect.objectContaining({ esito: 'voce-congelata' }))
      expect(h.logEvento).toHaveBeenCalledWith('registro', 'error', expect.anything(), expect.anything())
    }
    expect(letturaSblocchi()).toBe(0)
  })

  it('statoVoci: una lettura dei periodi e una degli scrutini per tutto il lotto', async () => {
    const r = await statoVoci(
      client(),
      maestra,
      [
        voce({ id: VOCE_1, dataEvento: IERI, giornoSalvataggio: IERI }), // in P1, aperto
        voce({ id: VOCE_2, dataEvento: ESTATE, giornoSalvataggio: IERI }), // in P_ESTATE, chiuso
        voce({ id: VOCE_3, tipo: 'nota', dataEvento: IERI }), // non conta dal salvataggio
      ],
      ADESSO,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual({ modificabile: true, bloccata: false, congelata: false, giorniLimite: 2 })
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual({ modificabile: false, bloccata: true, congelata: true, giorniLimite: 2 })
    const nota = r.esiti.get(chiaveVoce('nota', VOCE_3))
    expect(nota).toEqual({ modificabile: true, bloccata: false, giorniLimite: 2 })
    expect(nota).not.toHaveProperty('congelata')
    expect(tabelle.filter((t) => t === 'scrutinio_periodi')).toHaveLength(1)
    expect(tabelle.filter((t) => t === 'scrutini')).toHaveLength(1)
  })

  it('statoVoci: lo sblocco riapre la voce congelata, e la UI smette di vederla congelata', async () => {
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_2, sbloccato_il: SBLOCCO_DOPO }]
    const r = await statoVoci(
      client(), maestra, [voce({ id: VOCE_2, dataEvento: ESTATE, giornoSalvataggio: IERI })], ADESSO,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual({
      modificabile: true, bloccata: false, congelata: false, giorniLimite: 2,
    })
  })

  it('statoVoci: uno sblocco dato PRIMA della chiusura lascia la voce congelata, uno DOPO la riapre (per voce e per giorno)', async () => {
    const voci = [
      voce({ id: VOCE_1, dataEvento: ESTATE, giornoSalvataggio: IERI }), // sblocco per voce
      voce({ id: VOCE_2, dataEvento: ESTATE, giornoSalvataggio: '2026-08-01' }), // sblocco del giorno del salvataggio
    ]
    const stato = async () => {
      const r = await statoVoci(client(), maestra, voci, ADESSO)
      expect(r.ok).toBe(true)
      return r.ok ? r.esiti : new Map()
    }
    db.sblocchi_audit = [
      { id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_PRIMA },
      { id: 's2', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-08-01', sbloccato_il: SBLOCCO_PRIMA },
    ]
    let esiti = await stato()
    const chiuso = { modificabile: false, bloccata: true, congelata: true, giorniLimite: 2 }
    expect(esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual(chiuso)
    expect(esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual(chiuso)

    db.sblocchi_audit = [
      { id: 's3', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO },
      { id: 's4', entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-08-01', sbloccato_il: SBLOCCO_DOPO },
    ]
    esiti = await stato()
    const aperto = { modificabile: true, bloccata: false, congelata: false, giorniLimite: 2 }
    expect(esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual(aperto)
    expect(esiti.get(chiaveVoce('valutazione', VOCE_2))).toEqual(aperto)
  })

  it('statoVoci: una chiusura senza `chiuso_il` resta congelata per tutti e non legge gli sblocchi', async () => {
    db.scrutini = [{ id: 'sc1', section_id: SEZ_A, periodo_id: P_ESTATE, stato: 'chiuso', chiuso_il: null }]
    db.sblocchi_audit = [{ id: 's1', entita_tipo: 'valutazione', entita_id: VOCE_1, sbloccato_il: SBLOCCO_DOPO }]
    const r = await statoVoci(client(), maestra, [voce({ dataEvento: ESTATE, giornoSalvataggio: IERI })], ADESSO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VOCE_1))).toEqual({
      modificabile: false, bloccata: true, congelata: true, giorniLimite: 2,
    })
    expect(letturaSblocchi()).toBe(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro', 'info', expect.objectContaining({ esito: 'scrutinio-chiuso-senza-data', n: 1 }),
    )
  })

  it('statoVoci: lotto su DUE sedi, ognuna col suo scrutinio', async () => {
    // SEDE_B ha un solo periodo, d'autunno, già chiuso per SEZ_B; d'estate non ne ha nessuno.
    db.scrutinio_periodi.push(
      periodo({
        id: P1_SEDE_B, scuola_id: SEDE_B, anno_scolastico: '2026/2027', ordine: 1,
        data_inizio: '2026-09-01', data_fine: '2027-01-31',
      }),
    )
    db.scrutini.push({ id: 'sc2', section_id: SEZ_B, periodo_id: P1_SEDE_B, stato: 'chiuso' })
    const r = await statoVoci(
      client(),
      maestra,
      [
        voce({ id: VOCE_1, dataEvento: ESTATE, giornoSalvataggio: IERI }), // SEDE_A, estate chiusa: congelata
        voce({ id: VOCE_2, sectionId: SEZ_B, scuolaId: SEDE_B, dataEvento: '2026-09-02', giornoSalvataggio: IERI }), // SEDE_B, autunno chiuso: congelata
        voce({ id: VOCE_3, sectionId: SEZ_B, scuolaId: SEDE_B, dataEvento: ESTATE, giornoSalvataggio: IERI }), // SEDE_B, estate senza periodo: aperta
        voce({ id: VOCE_4, dataEvento: '2026-09-02', giornoSalvataggio: IERI }), // SEDE_A, autunno aperto
      ],
      ADESSO,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const congelata = (id: string) => (r.esiti.get(chiaveVoce('valutazione', id)) as { congelata?: boolean }).congelata
    expect(congelata(VOCE_1)).toBe(true)
    expect(congelata(VOCE_2)).toBe(true)
    expect(congelata(VOCE_3)).toBe(false)
    expect(congelata(VOCE_4)).toBe(false)
    expect(tabelle.filter((t) => t === 'scrutinio_periodi')).toHaveLength(1)
    expect(tabelle.filter((t) => t === 'scrutini')).toHaveLength(1)
  })

  it('statoVoci: lo staff resta nel cortocircuito, senza congelata e senza leggere i periodi', async () => {
    const r = await statoVoci(client(), segreteria, [voce({ dataEvento: ESTATE, giornoSalvataggio: IERI })], ADESSO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const esito = r.esiti.get(chiaveVoce('valutazione', VOCE_1))
    expect(esito).toEqual({ modificabile: true, bloccata: false, giorniLimite: 0 })
    expect(esito).not.toHaveProperty('congelata')
    expect(tabelle).not.toContain('scrutinio_periodi')
  })

  it('statoVoci: guasto sui periodi o sugli scrutini è LETTURA_FALLITA per tutto il lotto', async () => {
    for (const chiave of ['scrutinio_periodi:select', 'scrutini:select']) {
      opzioni = { errori: { [chiave]: { code: '57014', message: 'timeout' } } }
      expect(await statoVoci(client(), maestra, [voce({ dataEvento: IERI })], ADESSO), chiave).toEqual({
        ok: false, stato: 500, codice: 'LETTURA_FALLITA',
      })
    }
  })

  it('statoVoci: un lotto senza voci dal salvataggio non legge i periodi', async () => {
    const r = await statoVoci(client(), maestra, [voce({ tipo: 'nota', dataEvento: IERI })], ADESSO)
    expect(r.ok).toBe(true)
    expect(tabelle).not.toContain('scrutinio_periodi')
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

  it('rispostaPermessoNegato: QUADRIMESTRE_CHIUSO', async () => {
    const r = rispostaPermessoNegato({ ok: false, stato: 423, codice: 'QUADRIMESTRE_CHIUSO' })
    expect(r.status).toBe(423)
    const corpo = await r.json()
    expect(corpo).toMatchObject({ codice: 'QUADRIMESTRE_CHIUSO', locked: true })
    expect(corpo.error).toContain('scrutinio chiuso')
    // Non è un termine scaduto: nessun limite in giorni nel corpo.
    expect(corpo).not.toHaveProperty('giorniLimite')
  })
})
