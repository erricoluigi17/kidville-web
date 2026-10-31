import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Riga } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * CRM della segreteria · l'aggancio del bambino all'alunno (Compito 4 del piano «quota e disponibilità»).
 *
 * `agganciaAlunno` è la porta sulla funzione SQL `crm_aggancia_alunno`; `agganciaDaImport` la usa per ogni
 * figlio di una domanda appena importata; `alunnoDaDomandaImportata` ritrova l'alunno quando la domanda era
 * già stata importata PRIMA di essere collegata al bambino. Tutte e tre NON LANCIANO MAI: sono chiamate
 * dentro l'import e dentro il collegamento, che non devono fallire per colpa del CRM.
 *
 * Il database è il finto che APPLICA i filtri: «un alunno di un'altra sede non si ritrova» è provato dal
 * filtro `.eq('scuola_id')` che toglie davvero la riga. La funzione SQL è finta di test (la prova SQL vera
 * sta in `migrazione-quota-settimane-sql.test.ts`).
 *
 * Solo dati di prova: «Bimbo Prova», sedi da `fixtures/sedi.ts`.
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

import { agganciaAlunno, agganciaDaImport, alunnoDaDomandaImportata } from '@/lib/crm/aggancio-alunno'
import { redact } from '@/lib/logging/redact'

const DOMANDA = 'd1d1d1d1-0000-4000-8000-000000000001'
const B0 = 'b0b0b0b0-0000-4000-8000-000000000000'
const B1 = 'b1b1b1b1-0000-4000-8000-000000000001'
const B_ALTRA_SEDE = 'bbbbbbbb-0000-4000-8000-0000000000b9'
const A0 = 'a0a0a0a0-0000-4000-8000-000000000000'
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const A2 = 'a2a2a2a2-0000-4000-8000-000000000002'
const A_ALTRA_SEDE = 'aaaaaaaa-0000-4000-8000-0000000000b9'
const UTENTE = 'c1c1c1c1-0000-4000-8000-000000000001'
const VOCE = 'e1e1e1e1-0000-4000-8000-000000000001'

/** I dati che NON devono mai finire in un log. */
const DATI_PERSONALI = ['Bimbo', 'Bimba', 'Gemello', 'Gemella', 'Prova', '2024-03-05', '2023-01-02']

type ChiamataRpc = { nome: string; args: Riga }
let chiamate: ChiamataRpc[]
let rispostaRpc: (args: Riga) => { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>

function conDb(db: DBFinto, errori?: OpzioniFinto['errori']): SupabaseClient {
  return creaFintoSupabase(db, [], {
    errori,
    rpc: {
      crm_aggancia_alunno: async (args) => {
        chiamate.push({ nome: 'crm_aggancia_alunno', args })
        return await rispostaRpc(args)
      },
    },
  })
}

const bambino = (id: string, figlio: number, extra: Riga = {}): Riga => ({
  id,
  scuola_id: SEDE_A,
  scheda_id: 'f1f1f1f1-0000-4000-8000-000000000001',
  domanda_id: DOMANDA,
  domanda_figlio: figlio,
  alunno_id: null,
  ...extra,
})

const rispondeOk = (collegato = true, passaggio: unknown = null) => {
  rispostaRpc = () => ({ data: { esito: 'ok', collegato, passaggio }, error: null })
}

beforeEach(() => {
  h.log.length = 0
  chiamate = []
  rispondeOk()
})
afterEach(() => {
  const testo = JSON.stringify(h.log.map((r) => ({ evento: r.evento, livello: r.livello, campi: r.campi })))
  for (const dato of DATI_PERSONALI) expect(testo, `«${dato}» è finito in un log`).not.toContain(dato)
})

const logCrm = () => h.log.filter((r) => r.evento === 'crm')

// ─────────────────────────────────────────────────────────────────────────────
// agganciaAlunno
// ─────────────────────────────────────────────────────────────────────────────

describe('agganciaAlunno — la porta sulla funzione SQL', () => {
  it('chiama crm_aggancia_alunno con bambino, alunno e chi lo fa (null = il sistema)', async () => {
    const esito = await agganciaAlunno(conDb({}), B0, A0, UTENTE)
    expect(chiamate).toEqual([
      { nome: 'crm_aggancia_alunno', args: { p_bambino_id: B0, p_alunno_id: A0, p_eseguito_da: UTENTE } },
    ])
    expect(esito).toEqual({ esito: 'ok', collegato: true, passaggio: null })

    await agganciaAlunno(conDb({}), B0, A0, null)
    expect(chiamate[1].args.p_eseguito_da).toBeNull()
  })

  it('ok con il passaggio della quota: lo traduce e lo registra nel log', async () => {
    rispondeOk(true, { esito: 'ok', pagamento_id: VOCE, incasso_id: null, voce_nuova: true })
    const esito = await agganciaAlunno(conDb({}), B0, A0, UTENTE)
    expect(esito).toEqual({
      esito: 'ok',
      collegato: true,
      passaggio: { esito: 'ok', pagamentoId: VOCE, incassoId: null, voceNuova: true },
    })
    expect(logCrm().some((r) => r.campi.esito === 'quota-in-contabilita' && r.campi.entita_id === B0)).toBe(true)
  })

  it('un aggancio che riesce lascia una riga di log col suo id (anche il successo si registra)', async () => {
    await agganciaAlunno(conDb({}), B0, A0, UTENTE)
    const riga = logCrm().find((r) => r.campi.esito === 'alunno-collegato:segreteria')
    expect(riga?.livello).toBe('info')
    expect(riga?.campi.entita_id).toBe(B0)
    expect(riga?.campi.alunno_id).toBe(A0)
  })

  it('chi ha collegato sta DENTRO esito (segreteria o sistema), non in una chiave «via» che il logger redige', async () => {
    await agganciaAlunno(conDb({}), B0, A0, UTENTE)
    await agganciaAlunno(conDb({}), B0, A0, null)
    rispondeOk(false)
    await agganciaAlunno(conDb({}), B0, A0, null)

    const esiti = logCrm().map((r) => r.campi.esito)
    expect(esiti).toContain('alunno-collegato:segreteria')
    expect(esiti).toContain('alunno-collegato:sistema')
    expect(esiti).toContain('alunno-gia-collegato:sistema')
    for (const r of logCrm()) expect(Object.keys(r.campi)).not.toContain('via')
  })

  it('con la redazione VERA l’informazione sopravvive: esito esce in chiaro, con chi ha collegato', async () => {
    await agganciaAlunno(conDb({}), B0, A0, null)
    const riga = logCrm().find((r) => String(r.campi.esito).startsWith('alunno-collegato'))
    expect(riga).toBeDefined()
    const uscito = redact(riga!.campi) as Record<string, unknown>
    expect(uscito.esito).toBe('alunno-collegato:sistema')
    expect(uscito.operazione).toBe(riga!.campi.operazione)
    // La prova che la chiave «via» NON sopravvive: è il motivo per cui l'informazione sta nel valore di esito.
    const conVia = redact({ esito: 'alunno-collegato', via: 'sistema' }) as Record<string, unknown>
    expect(conVia.via).not.toBe('sistema')
  })

  it('ok senza novità (collegato: false): è un esito, e dice che non è stato scritto niente', async () => {
    rispondeOk(false)
    const esito = await agganciaAlunno(conDb({}), B0, A0, UTENTE)
    expect(esito).toEqual({ esito: 'ok', collegato: false, passaggio: null })
    expect(logCrm().some((r) => r.campi.esito === 'alunno-gia-collegato:segreteria')).toBe(true)
  })

  it.each(['non_trovato', 'sede_diversa', 'gia_collegato_altro', 'alunno_gia_collegato'] as const)(
    'l’esito «%s» della funzione resta lo stesso, e lascia una riga di log',
    async (esito) => {
      rispostaRpc = () => ({ data: { esito }, error: null })
      expect(await agganciaAlunno(conDb({}), B0, A0, UTENTE)).toEqual({ esito })
      expect(logCrm().some((r) => r.campi.esito === `aggancio-rifiutato:${esito}` && r.campi.entita_id === B0)).toBe(true)
    },
  )

  it('23505 dalla funzione (la UNIQUE sull’alunno) è «alunno_gia_collegato», non un guasto', async () => {
    // Review Focus 2: l'import e un collegamento a mano arrivano insieme. La funzione di norma risponde con
    // l'esito; se il 23505 esce dalla funzione come errore, vale lo stesso.
    rispostaRpc = () => ({ data: null, error: { code: '23505', message: 'duplicate key' } })
    expect(await agganciaAlunno(conDb({}), B0, A0, UTENTE)).toEqual({ esito: 'alunno_gia_collegato' })
    expect(logCrm().some((r) => r.livello === 'error')).toBe(false)
    expect(logCrm().some((r) => r.campi.esito === 'aggancio-rifiutato:alunno_gia_collegato')).toBe(true)
  })

  it.each(['PGRST202', 'PGRST205', '42P01', '42883'])('%s dalla funzione: non_installato (warn, mai error)', async (code) => {
    rispostaRpc = () => ({ data: null, error: { code, message: 'manca' } })
    expect(await agganciaAlunno(conDb({}), B0, A0, UTENTE)).toEqual({ esito: 'non_installato' })
    const righe = logCrm()
    expect(righe.some((r) => r.livello === 'warn' && r.campi.esito === 'schema-crm-assente')).toBe(true)
    expect(righe.some((r) => r.livello === 'error')).toBe(false)
  })

  it.each(['42703', 'PGRST204'])(
    '%s dalla funzione NON è «CRM non installato»: è un errore vero nel suo corpo (error nel log)',
    async (code) => {
      rispostaRpc = () => ({ data: null, error: { code, message: 'colonna inesistente' } })
      expect(await agganciaAlunno(conDb({}), B0, A0, UTENTE)).toEqual({ esito: 'errore' })
      expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
    },
  )

  it('la funzione lancia: errore, e NON lancia', async () => {
    rispostaRpc = () => {
      throw new Error('rete caduta')
    }
    await expect(agganciaAlunno(conDb({}), B0, A0, UTENTE)).resolves.toEqual({ esito: 'errore' })
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
  })

  it.each([null, 'ciao', [], {}, { esito: 'boh' }, { esito: 'ok', collegato: true, passaggio: 'storto' }])(
    'una risposta che non si riconosce (%j) è «errore», mai un successo',
    async (data) => {
      rispostaRpc = () => ({ data, error: null })
      const esito = await agganciaAlunno(conDb({}), B0, A0, UTENTE)
      // Un `passaggio` illeggibile NON fa fallire il collegamento (già scritto): ma dice `errore` sul passaggio.
      if ((data as { esito?: string } | null)?.esito === 'ok') {
        expect(esito).toEqual({ esito: 'ok', collegato: true, passaggio: { esito: 'errore' } })
      } else {
        expect(esito).toEqual({ esito: 'errore' })
      }
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// agganciaDaImport
// ─────────────────────────────────────────────────────────────────────────────

describe('agganciaDaImport — dall’import, un aggancio per ogni figlio', () => {
  const figli = [
    { figlio: 0, alunnoId: A0 },
    { figlio: 1, alunnoId: A1 },
  ]

  it('con crm_bambini assente torna non_installato e non lancia', async () => {
    const supabase = conDb({ crm_bambini: [] }, { crm_bambini: { code: 'PGRST205', message: 'Could not find the table' } })
    await expect(agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })).resolves.toEqual({
      esito: 'non_installato',
    })
    expect(chiamate).toEqual([])
    expect(logCrm().some((r) => r.livello === 'warn' && r.campi.esito === 'schema-crm-assente')).toBe(true)
  })

  it('la colonna alunno_id non c’è ancora (42703): è «non installato», non un guasto', async () => {
    // La colonna nasce con la migrazione della quota: nella finestra fra il deploy e la migrazione manca.
    const supabase = conDb({ crm_bambini: [] }, { crm_bambini: { code: '42703', message: 'column alunno_id does not exist' } })
    await expect(agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })).resolves.toEqual({
      esito: 'non_installato',
    })
  })

  it('con la rpc che lancia torna errore e non lancia', async () => {
    rispostaRpc = () => {
      throw new Error('rete caduta')
    }
    const supabase = conDb({ crm_bambini: [bambino(B0, 0)] })
    await expect(agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })).resolves.toEqual({
      esito: 'errore',
    })
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
  })

  it('una lettura che cade (errore del database) torna errore e non lancia', async () => {
    const supabase = conDb({ crm_bambini: [] }, { crm_bambini: { code: '57014', message: 'timeout' } })
    await expect(agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })).resolves.toEqual({
      esito: 'errore',
    })
    expect(chiamate).toEqual([])
  })

  it('salta il bambino già collegato e aggancia l’altro', async () => {
    const supabase = conDb({ crm_bambini: [bambino(B0, 0, { alunno_id: A0 }), bambino(B1, 1)] })
    const esito = await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })
    expect(esito).toEqual({ esito: 'fatto', agganciati: 1 })
    // La rpc è chiamata UNA volta, per il bambino libero, con l'alunno del SUO figlio e «il sistema».
    expect(chiamate).toEqual([
      { nome: 'crm_aggancia_alunno', args: { p_bambino_id: B1, p_alunno_id: A1, p_eseguito_da: null } },
    ])
  })

  it('il figlio è quello della domanda: l’alunno si sceglie per (domanda, figlio), non per ordine', async () => {
    const supabase = conDb({ crm_bambini: [bambino(B1, 1), bambino(B0, 0)] })
    await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })
    const perBambino = Object.fromEntries(chiamate.map((c) => [c.args.p_bambino_id as string, c.args.p_alunno_id]))
    expect(perBambino).toEqual({ [B0]: A0, [B1]: A1 })
  })

  it('un bambino di un’altra sede con la stessa domanda non si tocca', async () => {
    const supabase = conDb({ crm_bambini: [bambino(B_ALTRA_SEDE, 0, { scuola_id: SEDE_B })] })
    const esito = await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })
    expect(esito).toEqual({ esito: 'fatto', agganciati: 0 })
    expect(chiamate).toEqual([])
  })

  it('un figlio della domanda senza bambino nel CRM (la norma) non è un errore', async () => {
    const supabase = conDb({ crm_bambini: [] })
    expect(await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })).toEqual({
      esito: 'fatto',
      agganciati: 0,
    })
    expect(chiamate).toEqual([])
  })

  it('lascia UNA riga di log per esito: aggancio-import, con la domanda e il conteggio', async () => {
    const supabase = conDb({ crm_bambini: [bambino(B0, 0), bambino(B1, 1)] })
    await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })
    const righe = logCrm().filter((r) => r.campi.esito === 'aggancio-import')
    expect(righe).toHaveLength(1)
    expect(righe[0].livello).toBe('info')
    expect(righe[0].campi).toMatchObject({ entita_id: DOMANDA, n: 2 })
  })

  it('se la funzione manca (non_installato dalla rpc) si ferma al primo e non insiste', async () => {
    rispostaRpc = () => ({ data: null, error: { code: 'PGRST202', message: 'manca' } })
    const supabase = conDb({ crm_bambini: [bambino(B0, 0), bambino(B1, 1)] })
    expect(await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli })).toEqual({
      esito: 'non_installato',
    })
    expect(chiamate).toHaveLength(1)
  })

  it('una domanda senza figli da agganciare non legge nemmeno il CRM', async () => {
    const supabase = conDb({ crm_bambini: [bambino(B0, 0)] })
    expect(await agganciaDaImport(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, figli: [] })).toEqual({
      esito: 'fatto',
      agganciati: 0,
    })
    expect(chiamate).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// alunnoDaDomandaImportata
// ─────────────────────────────────────────────────────────────────────────────

describe('alunnoDaDomandaImportata — la domanda era già stata importata', () => {
  const alunno = (id: string, nome: string, nascita: string | null, sede = SEDE_A): Riga => ({
    id,
    scuola_id: sede,
    nome,
    cognome: 'Prova',
    data_nascita: nascita,
  })
  const esito = (creati: string[], sede = SEDE_A): Riga => ({
    submission_id: DOMANDA,
    scuola_id: sede,
    stato: 'inviata',
    alunni_creati: creati,
  })
  const chiedi = (db: DBFinto, b: Partial<{ nome: string | null; dataNascita: string | null; scuolaId: string }> = {}, errori?: OpzioniFinto['errori']) =>
    alunnoDaDomandaImportata(conDb(db, errori), {
      domandaId: DOMANDA,
      scuolaId: b.scuolaId ?? SEDE_A,
      nome: b.nome === undefined ? 'Bimbo' : b.nome,
      dataNascita: b.dataNascita === undefined ? '2024-03-05' : b.dataNascita,
    })

  it('un solo alunno con la stessa nascita e lo stesso nome → il suo id', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0])],
      alunni: [alunno(A0, 'Bimbo', '2024-03-05')],
    }
    expect(await chiedi(db)).toBe(A0)
  })

  it('due gemelli con la stessa nascita e nomi diversi → quello col nome giusto', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0, A1])],
      alunni: [alunno(A0, 'Gemella', '2024-03-05'), alunno(A1, 'Bimbo', '2024-03-05')],
    }
    expect(await chiedi(db, { nome: 'Bimbo' })).toBe(A1)
    expect(await chiedi(db, { nome: 'Gemella' })).toBe(A0)
  })

  it('due alunni indistinguibili (stessa nascita e stesso nome) → null: non si sceglie a caso', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0, A1])],
      alunni: [alunno(A0, 'Bimbo', '2024-03-05'), alunno(A1, 'Bimbo', '2024-03-05')],
    }
    expect(await chiedi(db)).toBeNull()
  })

  it('un alunno di un’altra sede → null', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A_ALTRA_SEDE])],
      alunni: [alunno(A_ALTRA_SEDE, 'Bimbo', '2024-03-05', SEDE_B)],
    }
    expect(await chiedi(db)).toBeNull()
  })

  it('l’esito dell’import di un’altra sede non conta, nemmeno se la domanda coincide', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0], SEDE_B)],
      alunni: [alunno(A0, 'Bimbo', '2024-03-05')],
    }
    expect(await chiedi(db)).toBeNull()
  })

  it('nessun esito di import (la domanda non è stata importata) → null', async () => {
    const db: DBFinto = { iscrizioni_import_esiti: [], alunni: [alunno(A0, 'Bimbo', '2024-03-05')] }
    expect(await chiedi(db)).toBeNull()
  })

  it('l’import non ha creato nessun alunno (alunni_creati vuoto) → null, senza leggere gli alunni', async () => {
    const letture: string[] = []
    const supabase = creaFintoSupabase(
      { iscrizioni_import_esiti: [esito([])], alunni: [alunno(A0, 'Bimbo', '2024-03-05')] },
      letture,
    )
    expect(await alunnoDaDomandaImportata(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, nome: 'Bimbo', dataNascita: '2024-03-05' })).toBeNull()
    expect(letture).not.toContain('alunni')
  })

  it('un alunno creato dall’import ma con un’altra nascita → null', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0])],
      alunni: [alunno(A0, 'Bimbo', '2023-01-02')],
    }
    expect(await chiedi(db)).toBeNull()
  })

  it('senza data di nascita nel CRM serve il nome: un solo alunno col nome → il suo id', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0, A1])],
      alunni: [alunno(A0, 'Gemella', '2024-03-05'), alunno(A1, 'Bimbo', '2023-01-02')],
    }
    expect(await chiedi(db, { dataNascita: null, nome: 'Bimbo' })).toBe(A1)
  })

  it('senza data di nascita e senza nome non c’è niente da confrontare → null', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A0])],
      alunni: [alunno(A0, 'Bimbo', '2024-03-05')],
    }
    expect(await chiedi(db, { dataNascita: null, nome: null })).toBeNull()
  })

  it('un nome accentato o in maiuscolo si riconosce (stessa regola del collegamento)', async () => {
    const db: DBFinto = {
      iscrizioni_import_esiti: [esito([A2])],
      alunni: [alunno(A2, 'MARIA ÉLENA', '2024-03-05')],
    }
    expect(await chiedi(db, { nome: 'elena' })).toBe(A2)
  })

  it('legge gli ALUNNI, mai la domanda (la regola 1 di collegamento.ts)', async () => {
    const letture: string[] = []
    const supabase = creaFintoSupabase(
      { iscrizioni_import_esiti: [esito([A0])], alunni: [alunno(A0, 'Bimbo', '2024-03-05')], enrollment_submissions: [] },
      letture,
    )
    await alunnoDaDomandaImportata(supabase, { domandaId: DOMANDA, scuolaId: SEDE_A, nome: 'Bimbo', dataNascita: '2024-03-05' })
    expect(letture).toContain('iscrizioni_import_esiti')
    expect(letture).toContain('alunni')
    expect(letture).not.toContain('enrollment_submissions')
  })

  it('una lettura che cade → null, NON lancia, e lascia una riga di log', async () => {
    const db: DBFinto = { iscrizioni_import_esiti: [esito([A0])], alunni: [alunno(A0, 'Bimbo', '2024-03-05')] }
    expect(await chiedi(db, {}, { alunni: { code: '57014', message: 'timeout' } })).toBeNull()
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
  })

  it('tabella degli esiti assente (database indietro): null, un warn e non un error', async () => {
    const db: DBFinto = { iscrizioni_import_esiti: [], alunni: [] }
    expect(await chiedi(db, {}, { iscrizioni_import_esiti: { code: 'PGRST205', message: 'manca' } })).toBeNull()
    const righe = logCrm()
    expect(righe.some((r) => r.livello === 'warn')).toBe(true)
    expect(righe.some((r) => r.livello === 'error')).toBe(false)
  })
})
