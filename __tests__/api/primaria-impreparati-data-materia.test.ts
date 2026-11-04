import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_C } from '../fixtures/sedi'
import type { DBFinto, OpzioniFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

// =============================================================================
// IMPREPARATI DELLA PRIMARIA: STESSE REGOLE DEI VOTI (data, quadrimestre chiuso, materie assegnate, autore).
//
// Stesso impianto di `primaria-valutazioni-data-storico.test.ts`: gira il codice vero di tutti i moduli nuovi
// (`periodo`, `quadrimestre`, `materie-docente`, `permesso-voce`) e lo scope vero (`sections`, `alunni`,
// `utenti_sezioni`) sul database finto. I casi si preparano dando RIGHE alle tabelle, non risposte ai moduli. Si
// fingono solo il client (che passa dal finto), l'identità, l'audit, la notifica e la spia del logger.
//
// L'orologio è fisso (solo `Date`): il 04/11/2026 alle 11:00 a Roma. Il termine di un impreparato è di 2 giorni
// (`classe_orale`); il primo quadrimestre (P1) è aperto, l'estate (P_ESTATE) ha lo scrutinio chiuso per la 2A e basta.
//
// Gli impreparati di riferimento: I1 senza materia (di COLLEGA), I2 in Italiano di 2A (di MAESTRA), I3 in Matematica
// di 2A dichiarato dal GENITORE.
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
/** Lo scrutinio dell'estate si è chiuso il 10/10; uno sblocco riapre un impreparato congelato solo se è stato dato dopo. */
const CHIUSO_IL = '2026-10-10T08:00:00Z'
const SBLOCCO_PRIMA = '2026-10-05T08:00:00Z'
const SBLOCCO_DOPO = '2026-10-20T08:00:00Z'
const I1 = '1a100000-0000-4000-8000-000000000001'
const I2 = '1a100000-0000-4000-8000-000000000002'
const I3 = '1a100000-0000-4000-8000-000000000003'
const I4 = '1a100000-0000-4000-8000-000000000004'

/** Una sede usata SOLO dal test sulla configurazione mancante: non ha nessun periodo. */
const SEDE_SOLO_MEMO = SEDE_C

const h = vi.hoisted(() => {
  const ERRORE_SCHEMA = { code: 'PGRST204', message: 'colonna sconosciuta', details: null, hint: null }

  /** Una catena di query che qualunque metodo continua e che, attesa, risponde con l'errore di schema. */
  function catenaRespinta(): unknown {
    const risposta = { data: null, error: ERRORE_SCHEMA, count: null, status: 400, statusText: 'Bad Request' }
    const catena: unknown = new Proxy(
      {},
      {
        get: (_t, nome) => {
          if (nome === 'then') return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risposta).then(ok, ko)
          if (nome === 'single' || nome === 'maybeSingle') return async () => risposta
          return () => catena
        },
      },
    )
    return catena
  }

  const stato = {
    db: {} as Record<string, Record<string, unknown>[]>,
    tabelle: [] as string[],
    opzioni: {} as Record<string, unknown>,
    utente: {} as Record<string, unknown>,
    logEvento: vi.fn(),
    accoda: vi.fn(),
    /** Le colonne che il database «non migrato» della CI non ha: una INSERT/UPDATE che le porta torna `PGRST204`. */
    colonneAssenti: [] as string[],
    /** Ogni INSERT/UPDATE su `giustifiche_didattiche`, anche quelle respinte: le chiavi del payload, nell'ordine. */
    tentativi: [] as { operazione: string; chiavi: string[] }[],
    /**
     * Ogni `.or()` e `.is()` messo sulle query di `giustifiche_didattiche`, e ogni `.in()` su `utenti`: il finto li
     * applica, ma non li conta né ricorda con quali valori.
     */
    filtri: [] as { tabella: string; metodo: string; args: unknown[] }[],
    /**
     * Strumenta le query su `giustifiche_didattiche` e `utenti`: registra quei filtri (così «mai due `.or()` sulla
     * stessa query» e «gli autori letti sono solo quelli delle docenti» si possono provare) e fa respingere le
     * INSERT/UPDATE di `giustifiche_didattiche` che portano una colonna assente. Il resto passa intatto.
     */
    strumenta(client: unknown): unknown {
      const avvolgi = (tabella: string, oggetto: object): object =>
        new Proxy(oggetto, {
          get: (b, nome, r) => {
            const valore = Reflect.get(b, nome, r)
            if (typeof valore !== 'function' || nome === 'then') return valore
            return (...args: unknown[]) => {
              if (nome === 'or' || nome === 'is' || (tabella === 'utenti' && nome === 'in')) {
                stato.filtri.push({ tabella, metodo: nome, args })
              }
              if (tabella === 'giustifiche_didattiche' && (nome === 'insert' || nome === 'update')) {
                const payload = args[0] as Record<string, unknown> | Record<string, unknown>[]
                const chiavi = Object.keys(Array.isArray(payload) ? payload[0] : payload)
                stato.tentativi.push({ operazione: nome, chiavi })
                if (chiavi.some((k) => stato.colonneAssenti.includes(k))) return catenaRespinta()
              }
              const uscita = (valore as (...a: unknown[]) => unknown).apply(b, args)
              // I builder si concatenano; le Promise (`single`, `maybeSingle`) no.
              return uscita !== null && typeof uscita === 'object' && !(uscita instanceof Promise) ? avvolgi(tabella, uscita) : uscita
            }
          },
        })
      return new Proxy(client as object, {
        get: (bersaglio, nome, ricevente) => {
          const valore = Reflect.get(bersaglio, nome, ricevente)
          if (nome !== 'from') return valore
          return (tabella: string) => {
            const costruttore = (valore as (t: string) => object)(tabella)
            return tabella === 'giustifiche_didattiche' || tabella === 'utenti' ? avvolgi(tabella, costruttore) : costruttore
          }
        },
      })
    },
  }
  return stato
})

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => h.strumenta(crea(h.db, h.tabelle, h.opzioni)),
  }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: async () => ({ user: h.utente, response: null }),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: async () => undefined }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: (...a: unknown[]) => h.accoda(...a),
  notificaTitolariScrittura: async () => undefined,
}))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/primaria/giustifiche-didattiche/route'

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
  // Il GENITORE è fra gli utenti apposta: l'autore di un impreparato suo non deve uscire lo stesso.
  utenti: [
    { id: MAESTRA, nome: 'Maestra', cognome: 'Finta' },
    { id: COLLEGA, nome: 'Collega', cognome: 'Finta' },
    { id: GENITORE, nome: 'Genitore', cognome: 'Finto' },
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
  giustifiche_didattiche: [],
  notifiche: [],
  sblocchi_audit: [],
})

const CORPO = { sectionId: SEZ_A, alunnoId: ALUNNO_A, materiaId: MAT_ITA_A, data: '2026-11-04' }

const url = 'http://localhost/api/primaria/giustifiche-didattiche'
const intestazioni = { 'content-type': 'application/json' }

const post = (corpo: Record<string, unknown>) =>
  POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(corpo), headers: intestazioni }))
const patch = (corpo: Record<string, unknown>) =>
  PATCH(new NextRequest(url, { method: 'PATCH', body: JSON.stringify({ versioneAttesa: 0, ...corpo }), headers: intestazioni }))
const elimina = (id: string) =>
  DELETE(new NextRequest(`${url}?id=${id}&versioneAttesa=0`, { method: 'DELETE' }))
const elenco = (query: string) => GET(new NextRequest(`${url}?${query}`))

const inserimenti = () => scritture.filter((s) => s.tabella === 'giustifiche_didattiche' && s.operazione === 'insert')
const aggiornamenti = () => scritture.filter((s) => s.tabella === 'giustifiche_didattiche' && s.operazione === 'update')
const cancellazioni = () => scritture.filter((s) => s.tabella === 'giustifiche_didattiche' && s.operazione === 'delete')

/** Un impreparato già nel registro: di MAESTRA, in Italiano di 2A, salvato ieri con la data del 20/10. */
function impreparato(over: Riga = {}): Riga {
  return {
    id: I2,
    storico_versione: 0,
    alunno_id: ALUNNO_A,
    section_id: SEZ_A,
    materia_id: MAT_ITA_A,
    data: '2026-10-20',
    motivo: null,
    tipo: 'impreparato',
    origine: 'docente',
    creato_da: MAESTRA,
    creato_il: '2026-11-03T09:00:00Z',
    sections: { scuola_id: SEDE_A },
    materie: { nome: 'Italiano' },
    ...over,
  }
}

const SENZA_MATERIA = { id: I1, materia_id: null, materie: null, creato_da: COLLEGA }
const DEL_GENITORE = {
  id: I3,
  materia_id: MAT_MAT_A,
  materie: { nome: 'Matematica' },
  origine: 'genitore',
  tipo: 'giustificato',
  creato_da: GENITORE,
}

/** Quello che il database aggiunge da sé a una riga appena inserita: `creato_il` (il default della colonna). */
function comeLaScriveIlDb() {
  for (const r of h.db.giustifiche_didattiche) {
    if (!r.creato_il) r.creato_il = new Date().toISOString()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-04T10:00:00Z') })
  scritture.length = 0
  h.tabelle = []
  h.db = dbBase()
  h.opzioni = { scritture } satisfies OpzioniFinto
  h.colonneAssenti = []
  h.tentativi = []
  h.filtri = []
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
      expect.objectContaining({ esito: 'impreparato-data-futura', error_code: 'DATA_FUTURA' }),
    )
  })

  it('mezzanotte di Roma: 00:30 del 5/11 accetta il 5 e rifiuta il 6', async () => {
    vi.setSystemTime(new Date('2026-11-04T23:30:00Z'))

    const accettato = await post({ ...CORPO, data: '2026-11-05' })
    expect(accettato.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ data: '2026-11-05' })

    const rifiutato = await post({ ...CORPO, data: '2026-11-06' })
    expect(rifiutato.status).toBe(422)
    expect((await rifiutato.json()).codice).toBe('DATA_FUTURA')
    expect(inserimenti()).toHaveLength(1)
  })

  it('una data che non è YYYY-MM-DD → 400 dello schema, nessuna scrittura', async () => {
    const res = await post({ ...CORPO, data: '04/11/2026' })

    expect(res.status).toBe(400)
    expect(inserimenti()).toHaveLength(0)
    expect(h.tabelle).toEqual([])
  })

  it('insert con periodo_id del quadrimestre della data, e termine che corre dal salvataggio', async () => {
    const res = await post({ ...CORPO, data: '2026-10-14' })

    expect(res.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({
      data: '2026-10-14',
      periodo_id: P1,
      creato_da: MAESTRA,
      origine: 'docente',
      tipo: 'impreparato',
      materia_id: MAT_ITA_A,
    })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-segnato', periodo_assegnato: true, section_id: SEZ_A }),
      undefined,
      expect.objectContaining({ distingui: ['giustifica_id'] }),
    )

    // Il termine corre dal SALVATAGGIO (oggi), non dalla data di tre settimane fa: la docente lo corregge ancora.
    comeLaScriveIlDb()
    const lista = await (await elenco(`sectionId=${SEZ_A}&alunnoId=${ALUNNO_A}&materiaId=${MAT_ITA_A}`)).json()
    expect(lista.data).toHaveLength(1)
    expect(lista.data[0]).toMatchObject({ modificabile: true, bloccata: false, congelata: false, propria: true })
  })

  it('quadrimestre chiuso → 423 QUADRIMESTRE_CHIUSO per l’educator, 201 per la segreteria con periodo_id', async () => {
    const rifiutato = await post({ ...CORPO, data: '2026-06-15' })

    expect(rifiutato.status).toBe(423)
    expect(await rifiutato.json()).toEqual({
      error: 'Lo scrutinio del quadrimestre di questa data è chiuso: per inserire l’impreparato rivolgiti alla segreteria.',
      codice: 'QUADRIMESTRE_CHIUSO',
      locked: true,
    })
    expect(inserimenti()).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-quadrimestre-chiuso', error_code: 'QUADRIMESTRE_CHIUSO', section_id: SEZ_A }),
    )

    utente(SEGRETERIA, 'segreteria')
    const accettato = await post({ ...CORPO, data: '2026-06-15' })
    expect(accettato.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ data: '2026-06-15', periodo_id: P_ESTATE, creato_da: SEGRETERIA })
  })

  it('materia non sua → 403 MATERIA_NON_ASSEGNATA prima di leggere materie e periodi; senza materia → 201', async () => {
    const negato = await post({ ...CORPO, materiaId: MAT_MAT_A })

    expect(negato.status).toBe(403)
    expect((await negato.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(inserimenti()).toHaveLength(0)
    expect(h.tabelle).not.toContain('materie')
    expect(h.tabelle).not.toContain('scrutinio_periodi')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ esito: 'materia-non-assegnata', error_code: 'MATERIA_NON_ASSEGNATA', materia_id: MAT_MAT_A }),
    )

    // Senza materia (D20) non c'è niente da verificare: passa, e senza leggere le assegnazioni.
    h.tabelle.length = 0
    const { materiaId: _m, ...senzaMateria } = CORPO
    void _m
    const accettato = await post(senzaMateria)
    expect(accettato.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ materia_id: null })
    expect(h.tabelle).not.toContain('utenti_sezioni_materie')
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

  it('periodi mancanti (configurazione): 201 con periodo_id null, e il log di successo lo dice', async () => {
    utente(MAESTRA_C, 'educator', SEDE_SOLO_MEMO)

    const res = await post({ ...CORPO, alunnoId: ALUNNO_C, sectionId: SEZ_C, materiaId: MAT_ITA_C })

    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).toMatchObject({ periodo_id: null })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-segnato', periodo_assegnato: false }),
      undefined,
      expect.anything(),
    )
  })

  it('guasto dei periodi → 500 LETTURA_FALLITA, nessuna scrittura', async () => {
    h.opzioni = { scritture, errori: { 'scrutinio_periodi:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await post({ ...CORPO, data: '2026-10-14' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(inserimenti()).toHaveLength(0)
    expect(h.accoda).not.toHaveBeenCalled()
  })

  it('guasto degli scrutini → 500 LETTURA_FALLITA, mai un 423 inventato né un 201', async () => {
    h.opzioni = { scritture, errori: { 'scrutini:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await post({ ...CORPO, data: '2026-06-15' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(inserimenti()).toHaveLength(0)
  })

  // DB non migrato (la CI E2E). A degradare è la colonna NUOVA, una volta: `periodo_id`. `tipo` c'è in produzione da prima e
  // non si butta: se lo schema risponde ancora (è il DB della CI, che non ha nessuna delle due) c'è un'ultima ripetizione
  // senza. Ogni stadio lascia un log `info` con il numero dello stadio.
  const ripiegiDiSchema = () =>
    h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'colonne-nuove-non-disponibili-schema')

  it('manca solo periodo_id: UNA ripetizione senza, e `tipo` resta scritto e restituito', async () => {
    h.colonneAssenti = ['periodo_id']

    const res = await post({ ...CORPO, data: '2026-10-14', tipo: 'giustificato' })

    expect(res.status).toBe(201)
    expect(h.tentativi).toHaveLength(2)
    expect(h.tentativi[0].chiavi).toEqual(expect.arrayContaining(['tipo', 'periodo_id']))
    expect(h.tentativi[1].chiavi).toContain('tipo')
    expect(h.tentativi[1].chiavi).not.toContain('periodo_id')
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ tipo: 'giustificato' })
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('periodo_id')
    // Quello che si restituisce è quello che si è scritto davvero.
    expect((await res.json()).data.tipo).toBe('giustificato')
    expect(ripiegiDiSchema()).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'colonne-nuove-non-disponibili-schema', tentativo: 1 }),
      expect.objectContaining({ code: 'PGRST204' }),
    )
    // Il log di successo dice la verità: l'impreparato è entrato SENZA periodo.
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-segnato', tipo: 'giustificato', periodo_assegnato: false }),
      undefined,
      expect.anything(),
    )
  })

  it('mancano tipo e periodo_id (il DB della CI): tre prove, la terza senza nessuna delle due, due log di ripiego', async () => {
    h.colonneAssenti = ['tipo', 'periodo_id']

    const res = await post({ ...CORPO, data: '2026-10-14' })

    expect(res.status).toBe(201)
    expect(h.tentativi).toHaveLength(3)
    expect(h.tentativi[0].chiavi).toEqual(expect.arrayContaining(['tipo', 'periodo_id']))
    expect(h.tentativi[1].chiavi).toContain('tipo')
    expect(h.tentativi[1].chiavi).not.toContain('periodo_id')
    expect(h.tentativi[2].chiavi).not.toContain('tipo')
    expect(h.tentativi[2].chiavi).not.toContain('periodo_id')
    expect(inserimenti()).toHaveLength(1)
    expect(ripiegiDiSchema().map(([, , campi]) => campi.tentativo)).toEqual([1, 2])
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-segnato', periodo_assegnato: false }),
      undefined,
      expect.anything(),
    )
  })

  it('anche l’ultima ripetizione fallisce → 500 IMPREPARATO_NON_SALVATO, due soli ripiegi e nessuna notifica', async () => {
    h.opzioni = { scritture, errori: { 'giustifiche_didattiche:insert': { code: 'PGRST204' } } } satisfies OpzioniFinto

    const res = await post(CORPO)

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('IMPREPARATO_NON_SALVATO')
    expect(ripiegiDiSchema().map(([, , campi]) => campi.tentativo)).toEqual([1, 2])
    expect(h.accoda).not.toHaveBeenCalled()
  })
})

describe('PATCH e DELETE', () => {
  it('la docente sposta la data entro il termine → 200, data e periodo_id nuovi', async () => {
    h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]

    const res = await patch({ id: I2, data: '2026-10-05' })

    expect(res.status).toBe(200)
    expect(aggiornamenti()).toHaveLength(1)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ data: '2026-10-05', periodo_id: P1 })
  })

  it('senza data, o con la stessa data, periodo_id non si tocca', async () => {
    h.db.giustifiche_didattiche = [impreparato()]

    expect((await patch({ id: I2, motivo: 'libro' })).status).toBe(200)
    expect(aggiornamenti()[0].valori[0]).not.toHaveProperty('periodo_id')
    expect(aggiornamenti()[0].valori[0]).not.toHaveProperty('data')

    expect((await patch({ id: I2, data: '2026-10-20' })).status).toBe(200)
    expect(aggiornamenti()[1].valori[0]).toMatchObject({ data: '2026-10-20' })
    expect(aggiornamenti()[1].valori[0]).not.toHaveProperty('periodo_id')
  })

  it('data futura → 422 DATA_FUTURA, prima di leggere la voce', async () => {
    h.db.giustifiche_didattiche = [impreparato()]

    const res = await patch({ id: I2, data: '2026-11-05' })

    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('DATA_FUTURA')
    expect(h.tabelle).toEqual([])
    expect(aggiornamenti()).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-data-futura', error_code: 'DATA_FUTURA' }),
    )
  })

  it('da aperto a chiuso → 423 QUADRIMESTRE_CHIUSO; da chiuso ad aperto → 423', async () => {
    h.db.giustifiche_didattiche = [impreparato()]
    const verso = await patch({ id: I2, data: '2026-06-15' })
    expect(verso.status).toBe(423)
    expect(await verso.json()).toMatchObject({ codice: 'QUADRIMESTRE_CHIUSO', locked: true })

    h.db.giustifiche_didattiche = [impreparato({ data: '2026-06-15', periodo_id: P_ESTATE })]
    const da = await patch({ id: I2, data: '2026-10-05' })
    expect(da.status).toBe(423)
    expect((await da.json()).codice).toBe('QUADRIMESTRE_CHIUSO')

    expect(aggiornamenti()).toHaveLength(0)
  })

  it('congelato con lo sblocco per voce → 200 e periodo_id nuovo; senza → 423', async () => {
    h.db.giustifiche_didattiche = [impreparato({ data: '2026-06-15', periodo_id: P_ESTATE })]

    expect((await patch({ id: I2, data: '2026-10-05' })).status).toBe(423)
    expect(aggiornamenti()).toHaveLength(0)

    // Uno sblocco dato prima della chiusura dello scrutinio non lo riapre.
    h.db.sblocchi_audit = [{ entita_tipo: 'impreparato', entita_id: I2, sbloccato_il: SBLOCCO_PRIMA }]
    expect((await patch({ id: I2, data: '2026-10-05' })).status).toBe(423)
    expect(aggiornamenti()).toHaveLength(0)

    h.db.sblocchi_audit = [{ entita_tipo: 'impreparato', entita_id: I2, sbloccato_il: SBLOCCO_DOPO }]
    const res = await patch({ id: I2, data: '2026-10-05' })
    expect(res.status).toBe(200)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ data: '2026-10-05', periodo_id: P1 })
  })

  it('un impreparato fermo nel quadrimestre chiuso non si elimina nemmeno entro il termine (DELETE)', async () => {
    h.db.giustifiche_didattiche = [impreparato({ data: '2026-06-15', periodo_id: P_ESTATE })]

    const res = await elimina(I2)

    expect(res.status).toBe(423)
    expect((await res.json()).codice).toBe('QUADRIMESTRE_CHIUSO')
    expect(cancellazioni()).toHaveLength(0)
  })

  it('salvato ieri con la data di tre settimane fa → PATCH 200; salvato tre giorni fa con la data di ieri → 423 VOCE_BLOCCATA', async () => {
    h.db.giustifiche_didattiche = [impreparato({ data: '2026-10-14', creato_il: '2026-11-03T09:00:00Z' })]
    const entro = await patch({ id: I2, motivo: 'libro dimenticato' })
    expect(entro.status).toBe(200)
    expect(aggiornamenti()).toHaveLength(1)

    h.db.giustifiche_didattiche = [impreparato({ data: '2026-11-03', creato_il: '2026-11-01T09:00:00Z' })]
    const oltre = await patch({ id: I2, motivo: 'libro dimenticato' })
    expect(oltre.status).toBe(423)
    expect(await oltre.json()).toMatchObject({ codice: 'VOCE_BLOCCATA', giorniLimite: 2 })
    expect(aggiornamenti()).toHaveLength(1)
  })

  it('materia nuova non sua → 403 MATERIA_NON_ASSEGNATA; senza materia (null) → 200', async () => {
    h.db.giustifiche_didattiche = [impreparato({ ...SENZA_MATERIA, creato_da: MAESTRA })]

    const negata = await patch({ id: I1, materiaId: MAT_MAT_A })
    expect(negata.status).toBe(403)
    expect((await negata.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(aggiornamenti()).toHaveLength(0)

    h.db.giustifiche_didattiche = [impreparato()]
    const tolta = await patch({ id: I2, materiaId: null })
    expect(tolta.status).toBe(200)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ materia_id: null })
  })

  it('suo in una materia non più assegnata → 403 su PATCH e su DELETE', async () => {
    h.db.giustifiche_didattiche = [impreparato({ materia_id: MAT_MAT_A, materie: { nome: 'Matematica' } })]

    const modifica = await patch({ id: I2, motivo: 'x' })
    expect(modifica.status).toBe(403)
    expect((await modifica.json()).codice).toBe('MATERIA_NON_ASSEGNATA')

    const eliminazione = await elimina(I2)
    expect(eliminazione.status).toBe(403)
    expect((await eliminazione.json()).codice).toBe('MATERIA_NON_ASSEGNATA')

    expect(aggiornamenti()).toHaveLength(0)
    expect(cancellazioni()).toHaveLength(0)
  })

  it('quello del genitore legato a una materia: lo tocca solo chi la insegna (regola 19), PATCH e DELETE', async () => {
    h.db.giustifiche_didattiche = [impreparato({ ...DEL_GENITORE, data: '2026-11-04', creato_il: '2026-11-04T08:00:00Z' })]

    // MAESTRA è della classe ma non insegna Matematica.
    const modifica = await patch({ id: I3, motivo: 'x' })
    expect(modifica.status).toBe(403)
    expect((await modifica.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    const eliminazione = await elimina(I3)
    expect(eliminazione.status).toBe(403)
    expect((await eliminazione.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(aggiornamenti()).toHaveLength(0)
    expect(cancellazioni()).toHaveLength(0)

    // COLLEGA insegna Matematica in 2A: passa, con il flusso di sempre per il genitore.
    utente(COLLEGA, 'educator')
    expect((await patch({ id: I3, motivo: 'x' })).status).toBe(200)
    expect((await elimina(I3)).status).toBe(200)
    expect(aggiornamenti()).toHaveLength(1)
    expect(cancellazioni()).toHaveLength(1)
  })

  it('quello del genitore SENZA materia lo tocca qualunque docente della classe (D20)', async () => {
    h.db.giustifiche_didattiche = [
      impreparato({ ...DEL_GENITORE, id: I1, materia_id: null, materie: null, data: '2026-11-04', creato_il: '2026-11-04T08:00:00Z' }),
    ]
    utente(MAESTRA_SENZA_MATERIE, 'educator')

    expect((await patch({ id: I1, motivo: 'x' })).status).toBe(200)
    expect((await elimina(I1)).status).toBe(200)
  })

  it('guasto dei periodi → 500 su PATCH (con data) e su DELETE', async () => {
    h.db.giustifiche_didattiche = [impreparato()]
    h.opzioni = { scritture, errori: { 'scrutinio_periodi:select': { code: '57014' } } } satisfies OpzioniFinto

    const modifica = await patch({ id: I2, data: '2026-10-05' })
    expect(modifica.status).toBe(500)
    expect((await modifica.json()).codice).toBe('LETTURA_FALLITA')

    const eliminazione = await elimina(I2)
    expect(eliminazione.status).toBe(500)
    expect((await eliminazione.json()).codice).toBe('LETTURA_FALLITA')

    expect(aggiornamenti()).toHaveLength(0)
    expect(cancellazioni()).toHaveLength(0)
  })

  it('la segreteria che sposta la data con i periodi illeggibili → 500, e non ritocca niente', async () => {
    utente(SEGRETERIA, 'segreteria')
    h.db.giustifiche_didattiche = [impreparato()]
    const rettifica = vi.fn().mockResolvedValue({ data: [{ righe: [impreparato()] }], error: null })
    h.opzioni = {
      scritture,
      rpc: { storici_applica_rettifica: rettifica },
      errori: { 'scrutinio_periodi:select': { code: '57014' } },
    } satisfies OpzioniFinto

    const res = await patch({ id: I2, data: '2026-10-05' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(rettifica).not.toHaveBeenCalled()
    expect(aggiornamenti()).toHaveLength(0)
  })

  it('la segreteria che corregge una data passata scrive periodo_id anche nell’azione di rettifica', async () => {
    utente(SEGRETERIA, 'segreteria')
    h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]
    const rettifica = vi.fn().mockResolvedValue({ data: [{ righe: [impreparato({ data: '2026-06-15', periodo_id: P_ESTATE })] }], error: null })
    h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

    // La segreteria non è fermata dal quadrimestre chiuso, ma l'impreparato passa al periodo giusto.
    const res = await patch({ id: I2, data: '2026-06-15' })

    expect(res.status).toBe(200)
    expect(rettifica).toHaveBeenCalledTimes(1)
    const azioni = rettifica.mock.calls[0][0].azioni as Array<{ tabella: string; valori: Riga }>
    expect(azioni.find((a) => a.tabella === 'giustifiche_didattiche')?.valori).toMatchObject({ data: '2026-06-15', periodo_id: P_ESTATE })
  })
})

describe('PATCH con il database non migrato', () => {
  // L'update semplice è a due stadi come l'insert della POST: prima solo la colonna NUOVA (`periodo_id`), poi, se lo schema
  // risponde ancora, anche `tipo`. Ogni stadio lascia un log `info` con il suo numero.
  const ripiegiDiSchema = () =>
    h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'colonne-nuove-non-disponibili-schema')

  it('manca solo periodo_id: UNA ripetizione senza, `tipo` resta nei valori, 200 e log info', async () => {
    h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]
    h.colonneAssenti = ['periodo_id']

    const res = await patch({ id: I2, tipo: 'giustificato', data: '2026-10-05' })

    expect(res.status).toBe(200)
    expect(h.tentativi).toHaveLength(2)
    expect(h.tentativi[0].chiavi).toEqual(expect.arrayContaining(['tipo', 'data', 'periodo_id']))
    expect(h.tentativi[1].chiavi).toEqual(expect.arrayContaining(['tipo', 'data']))
    expect(h.tentativi[1].chiavi).not.toContain('periodo_id')
    expect(aggiornamenti()).toHaveLength(1)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ tipo: 'giustificato', data: '2026-10-05' })
    // Quello che si restituisce è quello che si è scritto davvero.
    expect((await res.json()).data).toMatchObject({ tipo: 'giustificato', data: '2026-10-05' })
    expect(ripiegiDiSchema()).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'colonne-nuove-non-disponibili-schema', tentativo: 1 }),
      expect.objectContaining({ code: 'PGRST204' }),
    )
  })

  it('mancano tipo e periodo_id (il DB della CI): tre prove, la terza senza nessuna delle due, due log di ripiego', async () => {
    h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]
    h.colonneAssenti = ['tipo', 'periodo_id']

    const res = await patch({ id: I2, tipo: 'giustificato', data: '2026-10-05' })

    expect(res.status).toBe(200)
    expect(h.tentativi).toHaveLength(3)
    expect(h.tentativi[1].chiavi).toContain('tipo')
    expect(h.tentativi[1].chiavi).not.toContain('periodo_id')
    expect(h.tentativi[2].chiavi).toEqual(['data'])
    expect(aggiornamenti()).toHaveLength(1)
    expect(aggiornamenti()[0].valori[0]).toMatchObject({ data: '2026-10-05' })
    expect(aggiornamenti()[0].valori[0]).not.toHaveProperty('tipo')
    expect(ripiegiDiSchema().map(([, , campi]) => campi.tentativo)).toEqual([1, 2])
  })

  it('manca tipo e la PATCH non cambia la data: niente periodo_id da togliere, una sola ripetizione (stadio 2); se non resta niente, nessuna modifica', async () => {
    h.db.giustifiche_didattiche = [impreparato()]
    h.colonneAssenti = ['tipo']

    const res = await patch({ id: I2, tipo: 'giustificato' })

    expect(res.status).toBe(200)
    expect(h.tentativi).toHaveLength(1)
    expect(aggiornamenti()).toHaveLength(0)
    expect(ripiegiDiSchema().map(([, , campi]) => campi.tentativo)).toEqual([2])
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'impreparato-nessuna-modifica' }),
      undefined,
      expect.anything(),
    )
  })

  it('anche l’ultima ripetizione fallisce → 500 IMPREPARATO_NON_SALVATO, due soli ripiegi', async () => {
    h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]
    h.opzioni = { scritture, errori: { 'giustifiche_didattiche:update': { code: 'PGRST204' } } } satisfies OpzioniFinto

    const res = await patch({ id: I2, tipo: 'giustificato', data: '2026-10-05' })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('IMPREPARATO_NON_SALVATO')
    expect(ripiegiDiSchema().map(([, , campi]) => campi.tentativo)).toEqual([1, 2])
  })

  it('senza `tipo` nei valori non c’è uno stadio 2: la ripetizione senza periodo_id che fallisce ancora → 500, un solo ripiego', async () => {
    h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]
    h.opzioni = { scritture, errori: { 'giustifiche_didattiche:update': { code: 'PGRST204' } } } satisfies OpzioniFinto

    const res = await patch({ id: I2, data: '2026-10-05' })

    expect(res.status).toBe(500)
    expect(ripiegiDiSchema().map(([, , campi]) => campi.tentativo)).toEqual([1])
  })

  describe('rettifica storica della segreteria su una data passata', () => {
    // La RPC `storici_applica_rettifica` costruisce l'UPDATE dalle chiavi di `valori`: senza la colonna `periodo_id`
    // torna 42703. Il ripiego è il primo stadio dell'update semplice, e l'unico: UNA ripetizione senza `periodo_id`
    // (`tipo` non si tocca), con il log `info` e senza il log `error` della rettifica (non è un guasto, è un ripiego
    // previsto).
    const SCHEMA = { data: null, error: { code: '42703', message: 'colonna inesistente' } }
    const logErroreRettifica = () =>
      h.logEvento.mock.calls.filter(([, livello, campi]) => livello === 'error' && campi?.esito === 'rettifica-non-applicata')
    const valoriDellaChiamata = (rettifica: ReturnType<typeof vi.fn>, n: number) =>
      (rettifica.mock.calls[n][0].azioni as Array<{ tabella: string; valori: Riga }>).find((a) => a.tabella === 'giustifiche_didattiche')?.valori

    beforeEach(() => {
      utente(SEGRETERIA, 'segreteria')
      h.db.giustifiche_didattiche = [impreparato({ periodo_id: null })]
    })

    it('42703 → ripete una volta senza periodo_id, 200, log info e nessun log error di rettifica', async () => {
      const rettifica = vi.fn().mockResolvedValueOnce(SCHEMA).mockResolvedValueOnce({ data: [{ righe: [impreparato()] }], error: null })
      h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

      const res = await patch({ id: I2, data: '2026-10-05' })

      expect(res.status).toBe(200)
      expect(rettifica).toHaveBeenCalledTimes(2)
      expect(valoriDellaChiamata(rettifica, 0)).toMatchObject({ data: '2026-10-05', periodo_id: P1 })
      expect(valoriDellaChiamata(rettifica, 1)).toMatchObject({ data: '2026-10-05' })
      expect(valoriDellaChiamata(rettifica, 1)).not.toHaveProperty('periodo_id')
      expect(h.logEvento).toHaveBeenCalledWith(
        'registro',
        'info',
        expect.objectContaining({ esito: 'colonne-nuove-non-disponibili-schema', tentativo: 1 }),
        expect.objectContaining({ code: '42703' }),
      )
      expect(logErroreRettifica()).toHaveLength(0)
    })

    it('anche la seconda prova fallisce → 503 STORICO_NON_DISPONIBILE, una sola ripetizione e il log error di oggi', async () => {
      const rettifica = vi.fn().mockResolvedValue(SCHEMA)
      h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

      const res = await patch({ id: I2, data: '2026-10-05' })

      expect(res.status).toBe(503)
      expect((await res.json()).codice).toBe('STORICO_NON_DISPONIBILE')
      expect(rettifica).toHaveBeenCalledTimes(2)
      // Solo la seconda prova, quella senza ripiego, lascia il log error.
      expect(logErroreRettifica()).toHaveLength(1)
    })

    it('senza periodo_id nei valori (data invariata) non c’è ripiego: 503 subito, log error', async () => {
      const rettifica = vi.fn().mockResolvedValue(SCHEMA)
      h.opzioni = { scritture, rpc: { storici_applica_rettifica: rettifica } } satisfies OpzioniFinto

      const res = await patch({ id: I2, motivo: 'libro' })

      expect(res.status).toBe(503)
      expect(rettifica).toHaveBeenCalledTimes(1)
      expect(logErroreRettifica()).toHaveLength(1)
    })
  })
})

describe('GET', () => {
  // Il giorno della classe: I1 (senza materia), I2 (Italiano, di MAESTRA), I3 (Matematica, del genitore).
  const IL_GIORNO = '2026-11-03'
  const classe = `sectionId=${SEZ_A}&data=${IL_GIORNO}`
  const tutti = () => [
    impreparato({ ...SENZA_MATERIA, data: IL_GIORNO }),
    impreparato({ data: IL_GIORNO }),
    impreparato({ ...DEL_GENITORE, data: IL_GIORNO }),
  ]
  const ids = (corpo: { data: Riga[] }) => corpo.data.map((r) => r.id as string).sort()

  it('elenco di classe: MAESTRA vede I1 e I2, COLLEGA vede I1 e I3, la segreteria tutti e tre', async () => {
    h.db.giustifiche_didattiche = tutti()

    expect(ids(await (await elenco(classe)).json())).toEqual([I1, I2].sort())

    utente(COLLEGA, 'educator')
    expect(ids(await (await elenco(classe)).json())).toEqual([I1, I3].sort())

    utente(SEGRETERIA, 'segreteria')
    h.tabelle.length = 0
    expect(ids(await (await elenco(classe)).json())).toEqual([I1, I2, I3].sort())
    // Lo staff non legge le assegnazioni: non ne ha.
    expect(h.tabelle).not.toContain('utenti_sezioni_materie')
  })

  it('una docente senza materie assegnate vede solo gli impreparati senza materia', async () => {
    h.db.giustifiche_didattiche = tutti()
    utente(MAESTRA_SENZA_MATERIE, 'educator')

    expect(ids(await (await elenco(classe)).json())).toEqual([I1])
  })

  it('modulo per alunno con una materia non sua → 403 MATERIA_NON_ASSEGNATA; con una sua, quella più le senza materia', async () => {
    h.db.giustifiche_didattiche = tutti()

    const negata = await elenco(`sectionId=${SEZ_A}&alunnoId=${ALUNNO_A}&materiaId=${MAT_MAT_A}`)
    expect(negata.status).toBe(403)
    expect((await negata.json()).codice).toBe('MATERIA_NON_ASSEGNATA')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ esito: 'materia-non-assegnata', error_code: 'MATERIA_NON_ASSEGNATA', materia_id: MAT_MAT_A }),
    )

    const sua = await elenco(`sectionId=${SEZ_A}&alunnoId=${ALUNNO_A}&materiaId=${MAT_ITA_A}`)
    expect(sua.status).toBe(200)
    expect(ids(await sua.json())).toEqual([I1, I2].sort())
  })

  it('una materia indicata senza l’alunno non apre le altre: 403 se non sua, altrimenti sempre solo le sue', async () => {
    h.db.giustifiche_didattiche = tutti()

    expect((await elenco(`sectionId=${SEZ_A}&materiaId=${MAT_MAT_A}`)).status).toBe(403)

    const sua = await elenco(`sectionId=${SEZ_A}&materiaId=${MAT_ITA_A}`)
    expect(sua.status).toBe(200)
    expect(ids(await sua.json())).toEqual([I1, I2].sort())
  })

  it('un solo .or() per query: il modulo per alunno, la classe, una materia senza l’alunno; insieme vuoto con .is(); lo staff senza filtri', async () => {
    h.db.giustifiche_didattiche = tutti()
    const filtriDi = async (query: string) => {
      h.filtri = []
      expect((await elenco(query)).status).toBe(200)
      return h.filtri.filter((f) => f.tabella === 'giustifiche_didattiche')
    }

    expect(await filtriDi(`sectionId=${SEZ_A}&alunnoId=${ALUNNO_A}&materiaId=${MAT_ITA_A}`)).toEqual([
      { tabella: 'giustifiche_didattiche', metodo: 'or', args: [`materia_id.eq.${MAT_ITA_A},materia_id.is.null`] },
    ])
    expect(await filtriDi(classe)).toEqual([{ tabella: 'giustifiche_didattiche', metodo: 'or', args: [`materia_id.is.null,materia_id.in.(${MAT_ITA_A})`] }])
    expect(await filtriDi(`sectionId=${SEZ_A}&materiaId=${MAT_ITA_A}`)).toEqual([
      { tabella: 'giustifiche_didattiche', metodo: 'or', args: [`materia_id.is.null,materia_id.in.(${MAT_ITA_A})`] },
    ])

    utente(MAESTRA_SENZA_MATERIE, 'educator')
    expect(await filtriDi(classe)).toEqual([{ tabella: 'giustifiche_didattiche', metodo: 'is', args: ['materia_id', null] }])

    utente(SEGRETERIA, 'segreteria')
    expect(await filtriDi(classe)).toEqual([])
  })

  it('autore solo per gli impreparati della docente, propria, e senza creato_da', async () => {
    h.db.giustifiche_didattiche = tutti()

    const corpo = await (await elenco(classe)).json()
    expect(corpo.autoriDisponibili).toBe(true)
    const per = new Map<string, Riga>(corpo.data.map((r: Riga) => [r.id as string, r]))
    expect(per.get(I1)).toMatchObject({ autore: { id: COLLEGA, nome: 'Collega', cognome: 'Finta' }, propria: false })
    expect(per.get(I2)).toMatchObject({ autore: { id: MAESTRA, nome: 'Maestra', cognome: 'Finta' }, propria: true })
    expect(per.get(I2)).not.toHaveProperty('creato_da')

    // L'impreparato del genitore: nessun autore, anche se l'utente c'è nella tabella. COLLEGA vede I1 (suo) e I3.
    utente(COLLEGA, 'educator')
    h.filtri = []
    const delCollega = await (await elenco(classe)).json()
    // Si leggono solo gli autori delle docenti: il dichiarante di I3 non viene nemmeno cercato.
    const lettureAutori = h.filtri.filter((f) => f.tabella === 'utenti')
    expect(lettureAutori).toHaveLength(1)
    expect(lettureAutori[0].args).toEqual(['id', [COLLEGA]])
    const i3 = delCollega.data.find((r: Riga) => r.id === I3)
    expect(i3.autore).toBeNull()
    expect(i3.propria).toBe(false)
    expect(delCollega.data.find((r: Riga) => r.id === I1)).toMatchObject({ propria: true })
  })

  it('l’impreparato del genitore non ha autore nemmeno se il suo creatore è anche l’autore di un impreparato della docente', async () => {
    // Stesso utente in due parti: docente di I2 e, per I4, dichiarante. L'origine decide, non l'utente.
    h.db.giustifiche_didattiche = [
      impreparato({ data: IL_GIORNO }),
      impreparato({ ...DEL_GENITORE, id: I4, materia_id: null, materie: null, creato_da: MAESTRA, data: IL_GIORNO }),
    ]

    const corpo = await (await elenco(classe)).json()

    const per = new Map<string, Riga>(corpo.data.map((r: Riga) => [r.id as string, r]))
    expect(per.get(I2)).toMatchObject({ autore: { id: MAESTRA } })
    expect(per.get(I4)?.autore).toBeNull()
  })

  it('il nome dell’autore non entra mai in un log', async () => {
    h.db.giustifiche_didattiche = tutti()

    expect((await elenco(classe)).status).toBe(200)

    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log).not.toContain('Collega')
    expect(log).not.toContain('Maestra')
  })

  it('autori illeggibili: elenco lo stesso, autore null, autoriDisponibili false', async () => {
    h.db.giustifiche_didattiche = tutti()
    h.opzioni = { scritture, errori: { 'utenti:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await elenco(classe)
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

  it('congelata: l’impreparato della docente nel quadrimestre chiuso non è modificabile; la segreteria sì', async () => {
    h.db.giustifiche_didattiche = [impreparato({ data: '2026-06-15', periodo_id: P_ESTATE })]

    const docente = await (await elenco(`sectionId=${SEZ_A}&data=2026-06-15`)).json()
    expect(docente.data[0]).toMatchObject({ congelata: true, modificabile: false, bloccata: true })

    utente(SEGRETERIA, 'segreteria')
    const staff = await (await elenco(`sectionId=${SEZ_A}&data=2026-06-15`)).json()
    expect(staff.data[0]).toMatchObject({ congelata: false, modificabile: true, bloccata: false })
  })

  it('guasto dei periodi: elenco visibile, statoVociDisponibile false, congelata false', async () => {
    h.db.giustifiche_didattiche = tutti()
    h.opzioni = { scritture, errori: { 'scrutinio_periodi:select': { code: '57014' } } } satisfies OpzioniFinto

    const res = await elenco(classe)
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.data).toHaveLength(2)
    expect(corpo.statoVociDisponibile).toBe(false)
    expect(corpo.data[0]).toMatchObject({ modificabile: false, bloccata: false, congelata: false })
  })
})
