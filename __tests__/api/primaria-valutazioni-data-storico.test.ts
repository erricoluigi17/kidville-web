import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import type { DBFinto, OpzioniFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

// =============================================================================
// VOTI DELLA PRIMARIA: DATA DELLA PROVA, QUADRIMESTRE CHIUSO, MATERIE ASSEGNATE, STORICO CON L'AUTORE.
//
// Gira il codice vero di tutti i moduli nuovi (`periodo`, `quadrimestre`, `materie-docente`,
// `permesso-voce`) e lo scope vero (`sections`, `alunni`, `utenti_sezioni`) sul database finto: i casi si
// preparano dando RIGHE alle tabelle, non risposte ai moduli. Si fingono solo il client (che passa dal
// finto), l'identità, l'audit, la notifica, il giudizio descrittivo e la spia del logger.
//
// L'orologio è fisso (solo `Date`): il 04/11/2026 alle 11:00 a Roma. I termini sono 2 giorni per le orali e
// 15 per le scritte; il primo quadrimestre (P1) è aperto, l'estate (P_ESTATE) ha lo scrutinio chiuso per la
// 2A e basta.
// =============================================================================

const SEZ_A = '5e2a0000-0000-4000-8000-0000000000a1'
const SEZ_B = '5e2b0000-0000-4000-8000-0000000000b1'
const SEZ_C = '5e2c0000-0000-4000-8000-0000000000c1'
const MAT_ITA_A = 'a7a00000-0000-4000-8000-0000000000a1'
const MAT_MAT_A = 'a7a00000-0000-4000-8000-0000000000a2'
const MAT_ITA_B = 'a7b00000-0000-4000-8000-0000000000b1'
const MAT_MAT_B = 'a7b00000-0000-4000-8000-0000000000b2'
const MAT_ITA_C = 'a7c00000-0000-4000-8000-0000000000c1'
const MAESTRA = 'd0ce0000-0000-4000-8000-000000000001'
const COLLEGA = 'd0ce0000-0000-4000-8000-000000000002'
const MAESTRA_SENZA_MATERIE = 'd0ce0000-0000-4000-8000-000000000003'
const MAESTRA_C = 'd0ce0000-0000-4000-8000-000000000004'
const SEGRETERIA = 'd1919e00-0000-4000-8000-000000000001'
const GENITORE = 'fa310000-0000-4000-8000-000000000001'
const ALUNNO_A = 'a1a10000-0000-4000-8000-0000000000a1'
const ALUNNO_B = 'a1a10000-0000-4000-8000-0000000000b1'
const ALUNNO_C = 'a1a10000-0000-4000-8000-0000000000c1'
const P1 = '9e710000-0000-4000-8000-000000000001'
const P_ESTATE = '9e710000-0000-4000-8000-000000000002'
const V1 = '0a100000-0000-4000-8000-000000000001'
const V2 = '0a100000-0000-4000-8000-000000000002'
const V3 = '0a100000-0000-4000-8000-000000000003'

/**
 * Lo scrutinio dell'estate si è chiuso il 10/10 per la 2A. Uno sblocco della Direzione riapre un voto CONGELATO solo se è stato
 * dato dopo quell'istante: uno di prima l'ha dato per altro (per esempio correggere il registro di quel giorno).
 */
const CHIUSO_IL = '2026-10-10T08:00:00Z'
const SBLOCCO_PRIMA = '2026-10-05T08:00:00Z'
const SBLOCCO_DOPO = '2026-10-20T08:00:00Z'

/** Una sede usata SOLO dal test sul log delle date mancanti: il registro «una riga al giorno per sede» è in memoria del processo. */
const SEDE_SOLO_MEMO = SEDE_C

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  opzioni: {} as Record<string, unknown>,
  utente: {} as Record<string, unknown>,
  logEvento: vi.fn(),
  accoda: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => crea(h.db, h.tabelle, h.opzioni) }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: async () => ({ user: h.utente, response: null }),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: async () => undefined }))
vi.mock('@/lib/primaria/giudizio', () => ({ renderGiudizioDescrittivo: async () => 'Giudizio auto' }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: (...a: unknown[]) => h.accoda(...a),
  notificaTitolariScrittura: async () => undefined,
}))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/primaria/valutazioni/route'

const scritture: Scrittura[] = []

function utente(id: string, role: AppUser['role'], scuola: string = SEDE_A) {
  h.utente = { id, role, scuola_id: scuola }
}

function periodo(id: string, nome: string, ordine: number, anno: string, inizio: string | null, fine: string | null, attivo: boolean): Riga {
  return { id, scuola_id: SEDE_A, anno_scolastico: anno, nome, ordine, data_inizio: inizio, data_fine: fine, attivo }
}

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '2A' },
    { id: SEZ_B, scuola_id: SEDE_A, name: '2B' },
    { id: SEZ_C, scuola_id: SEDE_SOLO_MEMO, name: '3C' },
  ],
  alunni: [
    { id: ALUNNO_A, section_id: SEZ_A, scuola_id: SEDE_A, nome: 'Alunno' },
    { id: ALUNNO_B, section_id: SEZ_B, scuola_id: SEDE_A, nome: 'Alunno' },
    { id: ALUNNO_C, section_id: SEZ_C, scuola_id: SEDE_SOLO_MEMO, nome: 'Alunno' },
  ],
  materie: [
    { id: MAT_ITA_A, nome: 'Italiano', codice: 'italiano', scuola_id: SEDE_A, section_id: SEZ_A },
    { id: MAT_MAT_A, nome: 'Matematica', codice: 'matematica', scuola_id: SEDE_A, section_id: SEZ_A },
    { id: MAT_ITA_B, nome: 'Italiano', codice: 'italiano', scuola_id: SEDE_A, section_id: SEZ_B },
    { id: MAT_MAT_B, nome: 'Matematica', codice: 'matematica', scuola_id: SEDE_A, section_id: SEZ_B },
    { id: MAT_ITA_C, nome: 'Italiano', codice: 'italiano', scuola_id: SEDE_SOLO_MEMO, section_id: SEZ_C },
  ],
  utenti_sezioni: [
    { utente_id: MAESTRA, section_id: SEZ_A },
    { utente_id: MAESTRA, section_id: SEZ_B },
    { utente_id: COLLEGA, section_id: SEZ_A },
    { utente_id: MAESTRA_SENZA_MATERIE, section_id: SEZ_A },
    { utente_id: MAESTRA_C, section_id: SEZ_C },
  ],
  // MAESTRA: Italiano in 2A, Matematica in 2B. COLLEGA: Matematica in 2A. MAESTRA_SENZA_MATERIE: nessuna.
  utenti_sezioni_materie: [
    { utente_id: MAESTRA, section_id: SEZ_A, materia_id: MAT_ITA_A },
    { utente_id: MAESTRA, section_id: SEZ_B, materia_id: MAT_MAT_B },
    { utente_id: COLLEGA, section_id: SEZ_A, materia_id: MAT_MAT_A },
    { utente_id: MAESTRA_C, section_id: SEZ_C, materia_id: MAT_ITA_C },
  ],
  utenti: [
    { id: MAESTRA, nome: 'Maestra', cognome: 'Finta' },
    { id: COLLEGA, nome: 'Collega', cognome: 'Finta' },
  ],
  admin_settings: [
    { scuola_id: SEDE_A, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 },
    { scuola_id: SEDE_SOLO_MEMO, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 },
  ],
  // La sede SEDE_SOLO_MEMO non ha nessun periodo: configurazione mancante.
  scrutinio_periodi: [
    periodo(P1, 'Primo quadrimestre', 1, '2026/2027', '2026-09-01', '2027-01-31', true),
    periodo(P_ESTATE, 'Secondo quadrimestre', 2, '2025/2026', '2026-06-01', '2026-08-31', false),
  ],
  // Lo scrutinio dell'estate è chiuso per la 2A e per nessun'altra classe.
  scrutini: [{ section_id: SEZ_A, periodo_id: P_ESTATE, stato: 'chiuso', chiuso_il: CHIUSO_IL }],
  legame_genitori_alunni: [{ alunno_id: ALUNNO_A, genitore_id: GENITORE }],
  valutazioni: [],
  valutazione_obiettivi: [],
  obiettivi_apprendimento: [],
  notifiche: [],
  sblocchi_audit: [],
})

const CORPO = {
  alunnoId: ALUNNO_A,
  sectionId: SEZ_A,
  materiaId: MAT_ITA_A,
  modalita: 'sintetico',
  giudizioSintetico: 'Buono',
  argomento: 'Le tabelline',
}

const url = 'http://localhost/api/primaria/valutazioni'
const intestazioni = { 'content-type': 'application/json' }

const post = (corpo: Record<string, unknown>) =>
  POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(corpo), headers: intestazioni }))
const patch = (corpo: Record<string, unknown>) =>
  PATCH(new NextRequest(url, { method: 'PATCH', body: JSON.stringify({ versioneAttesa: 0, ...corpo }), headers: intestazioni }))
const elimina = (id: string) =>
  DELETE(new NextRequest(`${url}?id=${id}&versioneAttesa=0`, { method: 'DELETE' }))
const elenco = (alunnoId: string, materiaId?: string) =>
  GET(new NextRequest(`${url}?alunnoId=${alunnoId}${materiaId ? `&materiaId=${materiaId}` : ''}`))

const inserimenti = () => scritture.filter((s) => s.tabella === 'valutazioni' && s.operazione === 'insert')
const aggiornamenti = () => scritture.filter((s) => s.tabella === 'valutazioni' && s.operazione === 'update')
const cancellazioni = () => scritture.filter((s) => s.tabella === 'valutazioni' && s.operazione === 'delete')

/**
 * Quello che il database aggiunge da sé a una riga appena inserita e che la GET legge: `creato_il`
 * (il default della colonna) e gli embed `sections` e `valutazione_obiettivi`, che il finto non costruisce
 * dalla stringa di select.
 */
function comeLaScriveIlDb() {
  for (const r of h.db.valutazioni) {
    if (!r.creato_il) r.creato_il = new Date().toISOString()
    if (!r.sections) r.sections = { scuola_id: SEDE_A }
    if (!r.valutazione_obiettivi) r.valutazione_obiettivi = []
  }
}

/** Un voto già nel registro, di MAESTRA in Italiano di 2A, salvato ieri con la prova del 20/10. */
function voto(over: Riga = {}): Riga {
  return {
    id: V1,
    storico_versione: 0,
    alunno_id: ALUNNO_A,
    maestra_id: MAESTRA,
    section_id: SEZ_A,
    materia: 'Italiano',
    materia_id: MAT_ITA_A,
    argomento: 'Dettato',
    tipo: 'orale',
    lock_tipo: 'classe_orale',
    modalita: 'sintetico',
    giudizio_sintetico: 'Buono',
    giudizio_testo: null,
    annotazione_numerica: null,
    pubblicato: false,
    data_evento: '2026-10-20',
    periodo_id: P1,
    creato_il: '2026-11-03T09:00:00Z',
    valutazione_obiettivi: [],
    sections: { scuola_id: SEDE_A },
    ...over,
  }
}

const CORPO_MODIFICA = { id: V1, modalita: 'sintetico', giudizioSintetico: 'Ottimo', argomento: 'Dettato' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-04T10:00:00Z') })
  scritture.length = 0
  h.tabelle = []
  h.db = dbBase()
  h.opzioni = { scritture } satisfies OpzioniFinto
  h.accoda.mockResolvedValue(undefined)
  utente(MAESTRA, 'educator')
})
afterEach(() => vi.useRealTimers())

describe('POST', () => {
  it('data futura → 422 DATA_FUTURA, nessuna scrittura e nessuna lettura', async () => {
    const res = await post({ ...CORPO, data: '2026-11-05' })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'La data non può essere nel futuro.', codice: 'DATA_FUTURA' })
    expect(inserimenti()).toHaveLength(0)
    // «Prima di qualunque lettura»: nemmeno lo scope.
    expect(h.tabelle).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'voto-data-futura', error_code: 'DATA_FUTURA' }),
    )
  })

  it('tre settimane fa → 201, data_evento e periodo_id scritti, subito modificabile', async () => {
    const res = await post({ ...CORPO, data: '2026-10-14' })

    expect(res.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ data_evento: '2026-10-14', periodo_id: P1, maestra_id: MAESTRA })

    // Il termine corre dal SALVATAGGIO (oggi), non dalla data della prova: la docente lo corregge ancora.
    comeLaScriveIlDb()
    const lista = await (await elenco(ALUNNO_A, MAT_ITA_A)).json()
    expect(lista.data).toHaveLength(1)
    expect(lista.data[0]).toMatchObject({ modificabile: true, bloccata: false, congelata: false })
  })

  it('oggi → data_evento scritta lo stesso (D11)', async () => {
    const res = await post(CORPO)

    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ data_evento: '2026-11-04', periodo_id: P1 })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'valutazione-inserita', retrodatata: false, periodo_assegnato: true, section_id: SEZ_A }),
      undefined,
      expect.objectContaining({ distingui: ['valutazione_id'] }),
    )
  })

  it('un voto retrodatato lo dichiara nel log di successo', async () => {
    expect((await post({ ...CORPO, data: '2026-10-14' })).status).toBe(201)

    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'valutazione-inserita', retrodatata: true, periodo_assegnato: true }),
      undefined,
      expect.anything(),
    )
  })

  it('mezzanotte di Roma: 00:30 del 5/11 accetta il 5 e rifiuta il 6', async () => {
    vi.setSystemTime(new Date('2026-11-04T23:30:00Z'))

    const accettata = await post({ ...CORPO, data: '2026-11-05' })
    expect(accettata.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ data_evento: '2026-11-05' })

    const rifiutata = await post({ ...CORPO, data: '2026-11-06' })
    expect(rifiutata.status).toBe(422)
    expect((await rifiutata.json()).codice).toBe('DATA_FUTURA')
    expect(inserimenti()).toHaveLength(1)
  })

  it('scrutinio chiuso → 423 QUADRIMESTRE_CHIUSO per l’educator, nessun insert', async () => {
    const res = await post({ ...CORPO, data: '2026-06-15' })

    expect(res.status).toBe(423)
    expect(await res.json()).toEqual({
      error: 'Lo scrutinio del quadrimestre di questa data è chiuso: per inserire il voto rivolgiti alla segreteria.',
      codice: 'QUADRIMESTRE_CHIUSO',
      locked: true,
    })
    expect(inserimenti()).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'voto-quadrimestre-chiuso', error_code: 'QUADRIMESTRE_CHIUSO', section_id: SEZ_A }),
    )
  })

  it('segreteria a nome della docente nel quadrimestre chiuso → 201, poi per la docente è congelata', async () => {
    utente(SEGRETERIA, 'segreteria')
    const res = await post({ ...CORPO, data: '2026-06-15', docenteId: MAESTRA })

    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ maestra_id: MAESTRA, periodo_id: P_ESTATE, data_evento: '2026-06-15' })

    comeLaScriveIlDb()
    utente(MAESTRA, 'educator')
    const lista = await (await elenco(ALUNNO_A, MAT_ITA_A)).json()
    expect(lista.data).toHaveLength(1)
    expect(lista.data[0]).toMatchObject({ congelata: true, modificabile: false, bloccata: true, propria: true })
  })

  it('i quadrimestri si cercano nella sede della CLASSE, non in quella della materia (come la PATCH)', async () => {
    // La materia porta una sede diversa da quella della classe: i periodi (e il loro scrutinio chiuso) sono della sede A.
    h.db.materie = h.db.materie.map((m) => (m.id === MAT_ITA_A ? { ...m, scuola_id: SEDE_B } : m))

    const chiuso = await post({ ...CORPO, data: '2026-06-15' })
    expect(chiuso.status).toBe(423)
    expect((await chiuso.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(inserimenti()).toHaveLength(0)

    const aperto = await post({ ...CORPO, data: '2026-10-05' })
    expect(aperto.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ periodo_id: P1 })
    // Nessun log di «date mancanti» per la sede della materia: non è lei che si interroga.
    expect(h.logEvento).not.toHaveBeenCalledWith(
      'config', 'error', expect.objectContaining({ scuola_id: SEDE_B }),
    )
  })

  it('materia della collega → 403 MATERIA_NON_ASSEGNATA, prima di leggere obiettivi e periodi', async () => {
    const res = await post({ ...CORPO, materiaId: MAT_MAT_A })

    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(inserimenti()).toHaveLength(0)
    expect(h.tabelle).not.toContain('obiettivi_apprendimento')
    expect(h.tabelle).not.toContain('scrutinio_periodi')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ esito: 'materia-non-assegnata', error_code: 'MATERIA_NON_ASSEGNATA' }),
    )
  })

  it('stessa docente, altra classe: Italiano di 2B → 403; Matematica di 2B → 201', async () => {
    const italiano = await post({ ...CORPO, alunnoId: ALUNNO_B, sectionId: SEZ_B, materiaId: MAT_ITA_B })
    expect(italiano.status).toBe(403)
    expect((await italiano.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(inserimenti()).toHaveLength(0)

    const matematica = await post({ ...CORPO, alunnoId: ALUNNO_B, sectionId: SEZ_B, materiaId: MAT_MAT_B })
    expect(matematica.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
  })

  it('periodi mancanti → 201, periodo_id null, un solo log error', async () => {
    utente(MAESTRA_C, 'educator', SEDE_SOLO_MEMO)
    const corpo = { ...CORPO, alunnoId: ALUNNO_C, sectionId: SEZ_C, materiaId: MAT_ITA_C }

    expect((await post(corpo)).status).toBe(201)
    expect((await post(corpo)).status).toBe(201)

    expect(inserimenti()).toHaveLength(2)
    for (const s of inserimenti()) expect(s.valori[0]).toMatchObject({ periodo_id: null, data_evento: '2026-11-04' })
    const segnalazioni = h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'date-quadrimestre-mancanti')
    expect(segnalazioni).toHaveLength(1)
    expect(segnalazioni[0].slice(0, 2)).toEqual(['config', 'error'])
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'valutazione-inserita', periodo_assegnato: false }),
      undefined,
      expect.anything(),
    )
  })

  it('lettura dei periodi fallita → 500 LETTURA_FALLITA, nessuna scrittura', async () => {
    h.opzioni = { scritture, errori: { 'scrutinio_periodi:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await post({ ...CORPO, data: '2026-10-14' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(inserimenti()).toHaveLength(0)
  })

  it('lettura degli scrutini fallita → 500 LETTURA_FALLITA, mai un 423 inventato né un 201', async () => {
    h.opzioni = { scritture, errori: { 'scrutini:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await post({ ...CORPO, data: '2026-06-15' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(inserimenti()).toHaveLength(0)
  })

  it('notifica al genitore anche per un voto retrodatato della docente (D5)', async () => {
    const res = await post({ ...CORPO, data: '2026-10-14' })

    expect(res.status).toBe(201)
    expect(h.accoda).toHaveBeenCalledTimes(1)
    expect(h.accoda.mock.calls[0][1].operazione).toMatchObject({ giornoCompetenza: '2026-10-14', sopprimiGenitori: false })
  })
})

describe('PATCH e DELETE', () => {
  it('la docente sposta la data entro il termine → 200, data_evento e periodo_id nuovi', async () => {
    h.db.valutazioni = [voto({ periodo_id: null })]

    const res = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })

    expect(res.status).toBe(200)
    expect(aggiornamenti()).toHaveLength(1)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ data_evento: '2026-10-05', periodo_id: P1 })
  })

  it('senza data, o con la stessa data, periodo_id non si tocca', async () => {
    h.db.valutazioni = [voto()]

    expect((await patch(CORPO_MODIFICA)).status).toBe(200)
    expect(aggiornamenti()[0].valori[0]).not.toHaveProperty('periodo_id')
    expect(aggiornamenti()[0].valori[0]).not.toHaveProperty('data_evento')

    expect((await patch({ ...CORPO_MODIFICA, data: '2026-10-20' })).status).toBe(200)
    expect(aggiornamenti()[1].valori[0]).toMatchObject({ data_evento: '2026-10-20' })
    expect(aggiornamenti()[1].valori[0]).not.toHaveProperty('periodo_id')
  })

  it('data futura → 422 DATA_FUTURA, prima di leggere la voce', async () => {
    h.db.valutazioni = [voto()]

    const res = await patch({ ...CORPO_MODIFICA, data: '2026-11-05' })

    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('DATA_FUTURA')
    expect(h.tabelle).toEqual([])
    expect(aggiornamenti()).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'voto-data-futura', error_code: 'DATA_FUTURA' }),
    )
  })

  it('da aperto a chiuso → 423 QUADRIMESTRE_CHIUSO; da chiuso ad aperto → 423', async () => {
    h.db.valutazioni = [voto()]
    const verso = await patch({ ...CORPO_MODIFICA, data: '2026-06-15' })
    expect(verso.status).toBe(423)
    expect(await verso.json()).toMatchObject({ codice: 'QUADRIMESTRE_CHIUSO', locked: true })

    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]
    const da = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })
    expect(da.status).toBe(423)
    expect((await da.json()).codice).toBe('QUADRIMESTRE_CHIUSO')

    expect(aggiornamenti()).toHaveLength(0)
  })

  it('congelata con sblocco per voce → 200; senza → 423', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]
    const corpo = { ...CORPO_MODIFICA, data: '2026-10-05' }

    expect((await patch(corpo)).status).toBe(423)
    expect(aggiornamenti()).toHaveLength(0)

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_DOPO }]
    const res = await patch(corpo)
    expect(res.status).toBe(200)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ data_evento: '2026-10-05', periodo_id: P1 })
  })

  it('congelata: uno sblocco per voce dato PRIMA della chiusura non la riapre (423), uno DOPO sì (200)', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]
    const corpo = { ...CORPO_MODIFICA, data: '2026-10-05' }

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_PRIMA }]
    const vecchio = await patch(corpo)
    expect(vecchio.status).toBe(423)
    expect((await vecchio.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(aggiornamenti()).toHaveLength(0)

    h.db.sblocchi_audit.push({ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_DOPO })
    expect((await patch(corpo)).status).toBe(200)
    expect(aggiornamenti()).toHaveLength(1)
  })

  it('congelata: lo sblocco del GIORNO in cui è stata salvata, dato PRIMA della chiusura, non la riapre; dato DOPO sì', async () => {
    // Salvata il 1° ottobre con la prova del 15/06, quando lo scrutinio dell'estate era ancora aperto; chiuso il 10/10.
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE, creato_il: '2026-10-01T09:00:00Z' })]
    const giorno = (sbloccato_il: string) => ({
      entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-10-01', sbloccato_il,
    })

    h.db.sblocchi_audit = [giorno(SBLOCCO_PRIMA)]
    const vecchio = await patch(CORPO_MODIFICA)
    expect(vecchio.status).toBe(423)
    expect((await vecchio.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(aggiornamenti()).toHaveLength(0)

    h.db.sblocchi_audit = [giorno(SBLOCCO_DOPO)]
    expect((await patch(CORPO_MODIFICA)).status).toBe(200)
    expect(aggiornamenti()).toHaveLength(1)
  })

  it('spostare la data dentro il quadrimestre chiuso con uno sblocco vecchio → 423; con uno nuovo → 200', async () => {
    h.db.valutazioni = [voto()] // aperto: prova del 20/10, salvata ieri
    const corpo = { ...CORPO_MODIFICA, data: '2026-06-15' }

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_PRIMA }]
    const vecchio = await patch(corpo)
    expect(vecchio.status).toBe(423)
    expect((await vecchio.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(aggiornamenti()).toHaveLength(0)

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_DOPO }]
    expect((await patch(corpo)).status).toBe(200)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ data_evento: '2026-06-15', periodo_id: P_ESTATE })
  })

  it('congelata: nemmeno l’eliminazione passa con uno sblocco vecchio (DELETE); con uno nuovo sì', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_PRIMA }]
    const vecchio = await elimina(V1)
    expect(vecchio.status).toBe(423)
    expect((await vecchio.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(cancellazioni()).toHaveLength(0)

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_DOPO }]
    expect((await elimina(V1)).status).toBe(200)
    expect(cancellazioni()).toHaveLength(1)
  })

  it('un guasto nella lettura degli sblocchi di una voce congelata → 500 LETTURA_FALLITA, non un 423', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]
    h.opzioni = { scritture, errori: { 'sblocchi_audit:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(aggiornamenti()).toHaveLength(0)
  })

  it('un voto fermo nel quadrimestre chiuso non si elimina nemmeno entro il termine (DELETE)', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]

    const res = await elimina(V1)

    expect(res.status).toBe(423)
    expect((await res.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(cancellazioni()).toHaveLength(0)
  })

  it.each(['PGRST204', '42703'])(
    'database non migrato (%s anche dopo il ripiego): una PATCH con la data è 503 STORICO_NON_DISPONIBILE, senza data è un errore qualunque',
    async (code) => {
      h.db.valutazioni = [voto({ periodo_id: null })]
      h.opzioni = { scritture, errori: { 'valutazioni:update': { code, message: 'colonna sconosciuta' } } } satisfies OpzioniFinto

      const conData = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })
      expect(conData.status).toBe(503)
      expect((await conData.json()).codice).toBe('STORICO_NON_DISPONIBILE')

      const senzaData = await patch(CORPO_MODIFICA)
      expect(senzaData.status).toBe(500)
    },
  )

  it('salvata tre giorni fa con la data di ieri → 423 VOCE_BLOCCATA (il termine corre dal salvataggio)', async () => {
    h.db.valutazioni = [voto({ creato_il: '2026-11-01T09:00:00Z', data_evento: '2026-11-03' })]

    const res = await patch(CORPO_MODIFICA)

    expect(res.status).toBe(423)
    expect(await res.json()).toMatchObject({ codice: 'VOCE_BLOCCATA', giorniLimite: 2 })
    expect(aggiornamenti()).toHaveLength(0)
  })

  it('voto suo in una materia non più assegnata → 403 su PATCH e su DELETE', async () => {
    h.db.valutazioni = [voto({ materia: 'Matematica', materia_id: MAT_MAT_A })]

    const modifica = await patch(CORPO_MODIFICA)
    expect(modifica.status).toBe(403)
    expect((await modifica.json()).codice).toBe('MATERIA_NON_ASSEGNATA')

    const eliminazione = await elimina(V1)
    expect(eliminazione.status).toBe(403)
    expect((await eliminazione.json()).codice).toBe('MATERIA_NON_ASSEGNATA')

    expect(aggiornamenti()).toHaveLength(0)
    expect(cancellazioni()).toHaveLength(0)
  })

  it('lettura dei periodi fallita → 500 su PATCH (con data) e su DELETE', async () => {
    h.db.valutazioni = [voto()]
    h.opzioni = { scritture, errori: { 'scrutinio_periodi:select': { code: '57014' } } } satisfies OpzioniFinto

    const modifica = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })
    expect(modifica.status).toBe(500)
    expect((await modifica.json()).codice).toBe('LETTURA_FALLITA')

    const eliminazione = await elimina(V1)
    expect(eliminazione.status).toBe(500)
    expect((await eliminazione.json()).codice).toBe('LETTURA_FALLITA')

    expect(aggiornamenti()).toHaveLength(0)
    expect(cancellazioni()).toHaveLength(0)
  })

  it('la segreteria che sposta la data con i periodi illeggibili → 500, e non ritocca niente', async () => {
    utente(SEGRETERIA, 'segreteria')
    h.db.valutazioni = [voto()]
    const rettifica = vi.fn().mockResolvedValue({ data: [{ righe: [voto()] }], error: null })
    h.opzioni = {
      scritture,
      rpc: { storici_applica_rettifica: rettifica },
      errori: { 'scrutinio_periodi:select': { code: '57014' } },
    } satisfies OpzioniFinto

    const res = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(rettifica).not.toHaveBeenCalled()
    expect(aggiornamenti()).toHaveLength(0)
  })

  it('la segreteria che corregge una data passata scrive periodo_id anche nell’azione di rettifica', async () => {
    utente(SEGRETERIA, 'segreteria')
    h.db.valutazioni = [voto({ periodo_id: null })]
    const rettifica = vi.fn().mockResolvedValue({ data: [{ righe: [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })] }], error: null })
    h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

    // La segreteria non è fermata dal quadrimestre chiuso, ma il voto passa al periodo giusto.
    const res = await patch({ ...CORPO_MODIFICA, data: '2026-06-15' })

    expect(res.status).toBe(200)
    expect(rettifica).toHaveBeenCalledTimes(1)
    const azioni = rettifica.mock.calls[0][0].azioni as Array<{ tabella: string; valori: Riga }>
    expect(azioni.find((a) => a.tabella === 'valutazioni')?.valori).toMatchObject({ data_evento: '2026-06-15', periodo_id: P_ESTATE })
  })
})

describe('PATCH della segreteria su una data passata, con il database non migrato', () => {
  // La RPC `storici_applica_rettifica` costruisce l'UPDATE dalle chiavi di `valori`: senza la colonna `periodo_id`
  // torna 42703. Il ripiego è lo stesso dell'update semplice: UNA ripetizione senza, con il log `info` e senza il
  // log `error` della rettifica (non è un guasto, è un ripiego previsto).
  const SCHEMA = { data: null, error: { code: '42703', message: 'colonna inesistente' } }
  const logErroreRettifica = () =>
    h.logEvento.mock.calls.filter(([, livello, campi]) => livello === 'error' && campi?.esito === 'rettifica-non-applicata')
  const azioniDellaChiamata = (rettifica: ReturnType<typeof vi.fn>, n: number) =>
    rettifica.mock.calls[n][0].azioni as Array<{ tabella: string; valori: Riga }>

  beforeEach(() => {
    utente(SEGRETERIA, 'segreteria')
    h.db.valutazioni = [voto({ periodo_id: null })]
  })

  it('42703 → ripete una volta senza periodo_id, 200, log info e nessun log error di rettifica', async () => {
    const rettifica = vi.fn().mockResolvedValueOnce(SCHEMA).mockResolvedValueOnce({ data: [{ righe: [voto()] }], error: null })
    h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

    const res = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })

    expect(res.status).toBe(200)
    expect(rettifica).toHaveBeenCalledTimes(2)
    const prima = azioniDellaChiamata(rettifica, 0).find((a) => a.tabella === 'valutazioni')?.valori
    const seconda = azioniDellaChiamata(rettifica, 1).find((a) => a.tabella === 'valutazioni')?.valori
    expect(prima).toMatchObject({ data_evento: '2026-10-05', periodo_id: P1 })
    expect(seconda).toMatchObject({ data_evento: '2026-10-05' })
    expect(seconda).not.toHaveProperty('periodo_id')
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'colonne-nuove-non-disponibili-schema' }),
      expect.objectContaining({ code: '42703' }),
    )
    expect(logErroreRettifica()).toHaveLength(0)
  })

  it('anche la seconda prova fallisce → 503 STORICO_NON_DISPONIBILE, una sola ripetizione e il log error di oggi', async () => {
    const rettifica = vi.fn().mockResolvedValue(SCHEMA)
    h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

    const res = await patch({ ...CORPO_MODIFICA, data: '2026-10-05' })

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('STORICO_NON_DISPONIBILE')
    expect(rettifica).toHaveBeenCalledTimes(2)
    // Solo la seconda prova, quella senza ripiego, lascia il log error.
    expect(logErroreRettifica()).toHaveLength(1)
  })

  it('senza periodo_id nei valori (data invariata) non c’è ripiego: 503 subito, log error', async () => {
    const rettifica = vi.fn().mockResolvedValue(SCHEMA)
    h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

    const res = await patch(CORPO_MODIFICA)

    expect(res.status).toBe(503)
    expect(rettifica).toHaveBeenCalledTimes(1)
    expect(logErroreRettifica()).toHaveLength(1)
  })
})

describe('GET', () => {
  it('ordine per data della prova e poi per salvataggio, autore e propria', async () => {
    h.db.valutazioni = [
      // Salvato per ultimo, ma è la prova più vecchia: deve stare in fondo.
      voto({ id: V1, maestra_id: MAESTRA, data_evento: '2026-10-01', creato_il: '2026-11-03T08:00:00Z' }),
      voto({ id: V2, maestra_id: COLLEGA, data_evento: '2026-10-20', creato_il: '2026-10-20T10:00:00Z' }),
      voto({ id: V3, maestra_id: MAESTRA, data_evento: '2026-10-20', creato_il: '2026-10-20T11:00:00Z' }),
    ]

    const res = await elenco(ALUNNO_A, MAT_ITA_A)
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.autoriDisponibili).toBe(true)
    expect(corpo.data.map((r: Riga) => r.id)).toEqual([V3, V2, V1])
    const per = new Map<string, Riga>(corpo.data.map((r: Riga) => [r.id as string, r]))
    expect(per.get(V2)).toMatchObject({ autore: { id: COLLEGA, nome: 'Collega', cognome: 'Finta' }, propria: false })
    expect(per.get(V3)).toMatchObject({ autore: { id: MAESTRA, nome: 'Maestra', cognome: 'Finta' }, propria: true })
    // L'embed della sede non esce.
    expect(per.get(V3)).not.toHaveProperty('sections')
  })

  it('il nome dell’autore non entra mai in un log', async () => {
    h.db.valutazioni = [voto({ id: V2, maestra_id: COLLEGA })]

    expect((await elenco(ALUNNO_A, MAT_ITA_A)).status).toBe(200)

    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('Collega')
  })

  it('materia non sua → 403; senza materia solo le sue materie', async () => {
    h.db.valutazioni = [
      voto({ id: V1 }),
      voto({ id: V2, maestra_id: COLLEGA, materia: 'Matematica', materia_id: MAT_MAT_A }),
    ]

    const negata = await elenco(ALUNNO_A, MAT_MAT_A)
    expect(negata.status).toBe(403)
    expect((await negata.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ esito: 'materia-non-assegnata', error_code: 'MATERIA_NON_ASSEGNATA', materia_id: MAT_MAT_A }),
    )

    const tutte = await (await elenco(ALUNNO_A)).json()
    expect(tutte.data.map((r: Riga) => r.id)).toEqual([V1])
  })

  it('docente senza materie assegnate: elenco vuoto, senza leggere le valutazioni', async () => {
    h.db.valutazioni = [voto({ id: V1 })]
    utente(MAESTRA_SENZA_MATERIE, 'educator')

    const res = await elenco(ALUNNO_A)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [], statoVociDisponibile: true, autoriDisponibili: true, periodi: [] })
    expect(h.tabelle).not.toContain('valutazioni')
  })

  it('autori illeggibili: elenco lo stesso, autore null, autoriDisponibili false', async () => {
    h.db.valutazioni = [voto({ id: V1 }), voto({ id: V2, maestra_id: COLLEGA })]
    h.opzioni = { scritture, errori: { 'utenti:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await elenco(ALUNNO_A, MAT_ITA_A)
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.autoriDisponibili).toBe(false)
    expect(corpo.data).toHaveLength(2)
    for (const r of corpo.data) expect(r.autore).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      expect.objectContaining({ esito: 'autori-non-letti' }),
      expect.anything(),
    )
  })

  it('periodi della sede con le date nella risposta', async () => {
    h.db.valutazioni = [voto({ id: V1 })]
    h.db.scrutinio_periodi.push(periodo('9e710000-0000-4000-8000-000000000009', 'Senza date', 3, '2026/2027', '2027-02-01', null, true))

    const corpo = await (await elenco(ALUNNO_A, MAT_ITA_A)).json()

    const ids = corpo.periodi.map((p: { id: string }) => p.id)
    expect(ids).toContain(P1)
    expect(ids).toContain(P_ESTATE)
    // Un periodo con una sola data non copre niente: alla UI non serve.
    expect(ids).toHaveLength(2)
    expect(corpo.periodi.find((p: { id: string }) => p.id === P1)).toMatchObject({ data_inizio: '2026-09-01', data_fine: '2027-01-31' })
  })

  it('guasto dei periodi: elenco visibile, statoVociDisponibile false, periodi vuoti', async () => {
    h.db.valutazioni = [voto({ id: V1 })]
    h.opzioni = { scritture, errori: { 'scrutinio_periodi:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await elenco(ALUNNO_A, MAT_ITA_A)
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.data).toHaveLength(1)
    expect(corpo.statoVociDisponibile).toBe(false)
    expect(corpo.periodi).toEqual([])
    expect(corpo.data[0]).toMatchObject({ modificabile: false, bloccata: false, congelata: false })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      expect.objectContaining({ esito: 'periodi-non-letti', ripiego: true }),
      expect.anything(),
    )
  })

  it('voto congelato: lo sblocco del giorno dato PRIMA della chiusura non cambia nulla; dato DOPO la riapre (congelata/modificabile)', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE, creato_il: '2026-10-01T09:00:00Z' })]
    const giorno = (sbloccato_il: string) => ({
      entita_tipo: 'giorno', entita_id: null, section_id: SEZ_A, data: '2026-10-01', sbloccato_il,
    })
    const stato = async () => (await (await elenco(ALUNNO_A, MAT_ITA_A)).json()).data[0]

    h.db.sblocchi_audit = []
    expect(await stato()).toMatchObject({ congelata: true, bloccata: true, modificabile: false })

    h.db.sblocchi_audit = [giorno(SBLOCCO_PRIMA)]
    expect(await stato()).toMatchObject({ congelata: true, bloccata: true, modificabile: false })

    h.db.sblocchi_audit = [giorno(SBLOCCO_DOPO)]
    expect(await stato()).toMatchObject({ congelata: false, bloccata: false, modificabile: true })
  })

  it('voto congelato: lo sblocco per voce dato DOPO la chiusura lo riapre sulla GET, quello di prima no', async () => {
    h.db.valutazioni = [voto({ data_evento: '2026-06-15', periodo_id: P_ESTATE })]
    const stato = async () => (await (await elenco(ALUNNO_A, MAT_ITA_A)).json()).data[0]

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_PRIMA }]
    expect(await stato()).toMatchObject({ congelata: true, modificabile: false })

    h.db.sblocchi_audit = [{ entita_tipo: 'valutazione', entita_id: V1, sbloccato_il: SBLOCCO_DOPO }]
    expect(await stato()).toMatchObject({ congelata: false, modificabile: true })
  })

  it('lo staff vede tutte le materie', async () => {
    utente(SEGRETERIA, 'segreteria')
    h.db.valutazioni = [
      voto({ id: V1 }),
      voto({ id: V2, maestra_id: COLLEGA, materia: 'Matematica', materia_id: MAT_MAT_A }),
    ]

    const corpo = await (await elenco(ALUNNO_A)).json()

    expect(corpo.data.map((r: Riga) => r.id).sort()).toEqual([V1, V2].sort())
    expect(corpo.data.every((r: Riga) => r.modificabile === true && r.congelata === false)).toBe(true)
    // Lo staff non legge le assegnazioni: non ne ha.
    expect(h.tabelle).not.toContain('utenti_sezioni_materie')
  })
})
