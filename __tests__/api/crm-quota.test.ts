import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · la quota d'iscrizione: segnarla, correggerla, toglierla, ritentare il passaggio
 * in contabilità (Compito 3 del piano «quota e disponibilità»).
 *
 * Il database è il FINTO che applica davvero i filtri; le funzioni SQL (`crm_quota_segna`, `crm_quota_togli`,
 * `crm_quota_passa`) sono finte di test: provano che la route le chiami con gli argomenti giusti e che
 * traduca ogni loro esito nella risposta giusta. Il gate di ruolo è finto (decide solo chi entra);
 * `resolveScuoleAttive`, `assertSchedaInScope` e `scuoleDiUtente` sono quelli VERI, perché sono loro a
 * dire quale sede vale.
 *
 * Dati di prova soltanto: «Bimbo Prova», sedi da `fixtures/sedi.ts`.
 */

type ArgsRpc = Record<string, unknown>
type RispostaRpc = { data: unknown; error: unknown }

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  sedePropria: null as string | null,
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  letture: [] as string[],
  errori: {} as Record<string, unknown>,
  rpc: {} as Record<string, (args: ArgsRpc) => RispostaRpc | Promise<RispostaRpc>>,
  chiamateRpc: [] as { nome: string; args: ArgsRpc }[],
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: h.sedePropria } })
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.logEvento(...a)
      return vero.logEvento(...a)
    },
    logErrore: (...a: Parameters<typeof vero.logErrore>) => {
      h.logErrore(...a)
      return vero.logErrore(...a)
    },
  }
})
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notificaEvento(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    creaFintoSupabase(h.db as DBFinto, h.letture, {
      scritture: h.scritture as Scrittura[],
      errori: h.errori as Record<string, ErrorePostgrest>,
      rpc: Object.fromEntries(
        ['crm_quota_segna', 'crm_quota_togli', 'crm_quota_passa'].map((nome) => [
          nome,
          async (args: ArgsRpc) => {
            h.chiamateRpc.push({ nome, args })
            const impl = h.rpc[nome]
            if (!impl) throw new Error(`rpc ${nome} non preparata dal test`)
            return await impl(args)
          },
        ]),
      ),
    }),
}))

import { PUT, DELETE } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/route'
import { POST as RIPROVA } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/riprova/route'
import { PATCH as PATCH_BAMBINO } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/route'

const USER = '20000000-0000-4000-8000-0000000000aa'

const S1 = '30000000-0000-4000-8000-000000000001' // sede A
const SB = '30000000-0000-4000-8000-0000000000b1' // sede B

const B_LIBERO = '50000000-0000-4000-8000-0000000000a1' // sede A, anno «prossimo», non è ancora alunno
const B_ALUNNO = '50000000-0000-4000-8000-0000000000a2' // sede A, già alunno
const B_SENZA_ANNO = '50000000-0000-4000-8000-0000000000a3' // sede A, anno di ingresso non indicato
const B_SEDE_B = '50000000-0000-4000-8000-0000000000b1' // sede B, nella scheda SB
const B_INCOERENTE = '50000000-0000-4000-8000-0000000000b2' // dice scheda S1 ma la sede è B
const B_IN_CORSO = '50000000-0000-4000-8000-0000000000a4' // sede A, anno «in corso»

const ALUNNO = '80000000-0000-4000-8000-000000000001'
const VOCE = '60000000-0000-4000-8000-000000000001'
const INCASSO = '70000000-0000-4000-8000-000000000001'

/** Il momento «di adesso» dei test: il 31/10/2026, mattina. A Roma è lo stesso giorno. */
const ORA_BASE = '2026-10-31T10:00:00.000Z'
const OGGI = '2026-10-31'

const bambino = (id: string, sede: string, scheda: string, extra: Record<string, unknown> = {}) => ({
  id,
  scuola_id: sede,
  scheda_id: scheda,
  nome: 'Bimbo Prova',
  data_nascita: null,
  anno_ingresso: 'prossimo',
  esito: 'aperto',
  motivo_perdita: null,
  motivo_nota: null,
  esito_origine: null,
  esito_da: null,
  esito_il: null,
  domanda_id: null,
  domanda_figlio: null,
  domanda_collegata_il: null,
  nota_collegamento: null,
  da_verificare: false,
  alunno_id: null,
  quota_importo: null,
  quota_metodo: null,
  quota_anno: null,
  quota_stato: null,
  quota_saldata_il: null,
  creata_il: '2026-10-01T09:00:00.000Z',
  aggiornata_il: '2026-10-01T09:00:00.000Z',
  ...extra,
})

const richiesta = (metodo: string, percorso: string, corpo?: unknown) =>
  new NextRequest(`http://localhost${percorso}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { 'content-type': 'application/json' } }),
  })

const ctx = (id: string, bambinoId: string) => ({ params: Promise.resolve({ id, bambinoId }) })
const URL_QUOTA = (s: string, b: string) => `/api/admin/crm/schede/${s}/bambini/${b}/quota`

const put = (corpo: unknown, bambinoId = B_LIBERO, schedaId = S1) =>
  PUT(richiesta('PUT', URL_QUOTA(schedaId, bambinoId), corpo), ctx(schedaId, bambinoId))
const del = (bambinoId = B_LIBERO, schedaId = S1) =>
  DELETE(richiesta('DELETE', URL_QUOTA(schedaId, bambinoId)), ctx(schedaId, bambinoId))
const riprova = (bambinoId = B_LIBERO, schedaId = S1) =>
  RIPROVA(richiesta('POST', `${URL_QUOTA(schedaId, bambinoId)}/riprova`), ctx(schedaId, bambinoId))

const corpoValido = (extra: Record<string, unknown> = {}) => ({ importo: 150, metodo: 'contanti', ...extra })

/** La funzione SQL finta: risponde sempre con questo jsonb. */
const segnaRisponde = (data: unknown) => {
  h.rpc.crm_quota_segna = () => ({ data, error: null })
}
const segnaOk = (passaggio: unknown = null) => segnaRisponde({ esito: 'ok', movimento_id: null, corretta: false, passaggio })
const passaggioOk = (incassoId: string | null = INCASSO) => ({
  esito: 'ok',
  pagamento_id: VOCE,
  incasso_id: incassoId,
  voce_nuova: true,
  metodo: 'contanti',
})

const chiamate = (nome: string) => h.chiamateRpc.filter((c) => c.nome === nome)
const scritto = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)
const logCrm = () =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === 'crm')
    .map((c) => ({ livello: c[1] as string, campi: c[2] as Record<string, unknown> }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ORA_BASE))
  h.ruolo = 'segreteria'
  h.sedePropria = SEDE_A
  h.scritture = []
  h.letture = []
  h.errori = {}
  h.rpc = {}
  h.chiamateRpc = []
  h.notificaEvento.mockReset()
  h.notificaEvento.mockResolvedValue(undefined)
  h.logEvento.mockClear()
  h.logErrore.mockClear()
  h.db = {
    utenti: [{ id: USER, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null }],
    utenti_scuole: [],
    crm_schede: [
      { id: S1, scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' },
      { id: SB, scuola_id: SEDE_B, genitore_nome: 'Famiglia Prova' },
    ],
    crm_bambini: [
      bambino(B_LIBERO, SEDE_A, S1),
      bambino(B_ALUNNO, SEDE_A, S1, { alunno_id: ALUNNO }),
      bambino(B_SENZA_ANNO, SEDE_A, S1, { anno_ingresso: 'non_indicato' }),
      bambino(B_IN_CORSO, SEDE_A, S1, { anno_ingresso: 'in_corso' }),
      bambino(B_SEDE_B, SEDE_B, SB),
      bambino(B_INCOERENTE, SEDE_B, S1),
    ],
    cassa_chiusure: [],
    pagamenti: [{ id: VOCE, scuola_id: SEDE_A, stato: 'pagato', descrizione: 'Iscrizione 2027/28' }],
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PUT …/quota · segnare la quota', () => {
  it('segna 150 € in contanti: chiama crm_quota_segna con anno 2027 e giorno di oggi a Roma', async () => {
    segnaOk()
    const res = await put(corpoValido())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { stato: 'in_attesa', passaggio: null } })
    expect(chiamate('crm_quota_segna')).toEqual([
      {
        nome: 'crm_quota_segna',
        args: {
          p_bambino_id: B_LIBERO,
          p_importo: 150,
          p_metodo: 'contanti',
          p_giorno: OGGI,
          p_anno: 2027,
          p_eseguito_da: USER,
        },
      },
    ])
  })

  it('«in corso» è l’anno scolastico che corre (2026), «prossimo» il successivo (2027)', async () => {
    segnaOk()
    await put(corpoValido({ metodo: 'bonifico' }), B_IN_CORSO)
    await put(corpoValido({ metodo: 'bonifico' }), B_LIBERO)
    expect(chiamate('crm_quota_segna').map((c) => c.args.p_anno)).toEqual([2026, 2027])
  })

  it('il giorno scelto arriva alla funzione; «giorno» nullo o assente vale oggi', async () => {
    segnaOk()
    await put(corpoValido({ metodo: 'carta', giorno: '2026-10-20' }))
    await put(corpoValido({ metodo: 'carta', giorno: null }))
    await put(corpoValido({ metodo: 'carta' }))
    expect(chiamate('crm_quota_segna').map((c) => c.args.p_giorno)).toEqual(['2026-10-20', OGGI, OGGI])
  })

  it('rifiuta importo 0, negativo, con tre decimali, oltre il tetto o scritto all’italiana, con 400 e senza rpc', async () => {
    for (const importo of [0, -5, 150.555, 100000.01, '150,50', '', null, 'abc']) {
      const res = await put({ importo, metodo: 'contanti' })
      expect(res.status, `importo ${String(importo)}`).toBe(400)
    }
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('accetta 150.5, 19.99 e 1234.56 (zod e i decimali dei float) e li passa tali e quali', async () => {
    segnaOk()
    for (const importo of [150.5, 19.99, 1234.56]) {
      const res = await put({ importo, metodo: 'bonifico' })
      expect(res.status, `importo ${importo}`).toBe(200)
    }
    expect(chiamate('crm_quota_segna').map((c) => c.args.p_importo)).toEqual([150.5, 19.99, 1234.56])
  })

  it('un importo uscito da una somma di float (0.1 + 0.2) arriva alla funzione già a due decimali', async () => {
    segnaOk()
    const res = await put({ importo: 0.1 + 0.2, metodo: 'bonifico' })
    expect(res.status).toBe(200)
    expect(chiamate('crm_quota_segna')[0].args.p_importo).toBe(0.3)
  })

  it('rifiuta un metodo che non è contanti, carta o bonifico, e un corpo vuoto', async () => {
    expect((await put({ importo: 150, metodo: 'assegno' })).status).toBe(400)
    expect((await put({ importo: 150 })).status).toBe(400)
    expect((await put({})).status).toBe(400)
    expect((await put({ importo: 150, metodo: 'contanti', giorno: '2026-02-30' })).status).toBe(400)
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('rifiuta il giorno di domani con 422 QUOTA_GIORNO_FUTURO', async () => {
    const res = await put(corpoValido({ giorno: '2026-11-01' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('QUOTA_GIORNO_FUTURO')
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('alle 23:30 UTC del 31/10 accetta il giorno 2026-11-01 (a Roma è già oggi) e rifiuta il 2', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:30:00.000Z'))
    segnaOk()
    const buono = await put(corpoValido({ metodo: 'bonifico', giorno: '2026-11-01' }))
    expect(buono.status).toBe(200)
    const futuro = await put(corpoValido({ metodo: 'bonifico', giorno: '2026-11-02' }))
    expect(futuro.status).toBe(422)
    expect((await futuro.json()).codice).toBe('QUOTA_GIORNO_FUTURO')
    // senza giorno, oggi a Roma è l’1/11
    await put(corpoValido({ metodo: 'bonifico' }))
    expect(chiamate('crm_quota_segna').map((c) => c.args.p_giorno)).toEqual(['2026-11-01', '2026-11-01'])
  })

  it('anno di ingresso non indicato: 422 QUOTA_ANNO_MANCANTE, senza rpc', async () => {
    const res = await put(corpoValido(), B_SENZA_ANNO)
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('QUOTA_ANNO_MANCANTE')
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('contanti su un giorno già chiuso: 409 QUOTA_CASSA_CHIUSA con giornoProposto, senza rpc', async () => {
    h.db.cassa_chiusure = [{ id: 'c1', scuola_id: SEDE_A, eseguita_il: '2026-10-29T17:00:00.000Z' }]
    const res = await put(corpoValido({ giorno: '2026-10-29' }))
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('QUOTA_CASSA_CHIUSA')
    expect(corpo.giornoProposto).toBe(OGGI)
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('contanti: il giorno dopo l’ultima chiusura passa; si guarda la chiusura PIÙ RECENTE e solo della propria sede', async () => {
    h.db.cassa_chiusure = [
      { id: 'c1', scuola_id: SEDE_A, eseguita_il: '2026-10-10T17:00:00.000Z' },
      { id: 'c2', scuola_id: SEDE_A, eseguita_il: '2026-10-29T17:00:00.000Z' },
      { id: 'c3', scuola_id: SEDE_B, eseguita_il: '2026-10-31T09:00:00.000Z' }, // altra sede: non conta
    ]
    segnaOk()
    expect((await put(corpoValido({ giorno: '2026-10-30' }))).status).toBe(200)
    expect((await put(corpoValido({ giorno: '2026-10-15' }))).status).toBe(409)
    expect(chiamate('crm_quota_segna')).toHaveLength(1)
  })

  it('contanti di oggi dopo la chiusura di oggi: ammessi (soldi arrivati dopo)', async () => {
    h.db.cassa_chiusure = [{ id: 'c1', scuola_id: SEDE_A, eseguita_il: '2026-10-31T08:00:00.000Z' }]
    segnaOk()
    expect((await put(corpoValido())).status).toBe(200)
    expect((await put(corpoValido({ giorno: OGGI }))).status).toBe(200)
  })

  it('carta e bonifico non toccano la cassa: nessuna lettura delle chiusure, giorno chiuso o no', async () => {
    h.db.cassa_chiusure = [{ id: 'c1', scuola_id: SEDE_A, eseguita_il: '2026-10-29T17:00:00.000Z' }]
    segnaOk()
    expect((await put(corpoValido({ metodo: 'carta', giorno: '2026-10-20' }))).status).toBe(200)
    expect((await put(corpoValido({ metodo: 'bonifico', giorno: '2026-10-20' }))).status).toBe(200)
    expect(h.letture).not.toContain('cassa_chiusure')
  })

  it('bambino di un’altra sede: 404 e nessuna rpc (anche se dichiara la scheda giusta)', async () => {
    for (const bambinoId of [B_SEDE_B, B_INCOERENTE]) {
      const res = await put(corpoValido(), bambinoId)
      expect(res.status, bambinoId).toBe(404)
    }
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('un bambino inesistente: 404 SCHEDA_NON_TROVATA; con la scheda di un’altra sede lo dice prima il controllo di sede (403)', async () => {
    const altraScheda = await put(corpoValido(), B_LIBERO, SB)
    expect(altraScheda.status).toBe(403)
    const inesistente = await put(corpoValido(), '50000000-0000-4000-8000-0000000000ff')
    expect(inesistente.status).toBe(404)
    expect((await inesistente.json()).codice).toBe('SCHEDA_NON_TROVATA')
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('la scheda di un’altra sede: 403 e nessuna lettura del bambino né rpc', async () => {
    const res = await put(corpoValido(), B_SEDE_B, SB)
    expect(res.status).toBe(403)
    expect(h.letture).not.toContain('crm_bambini')
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('un id che non è un uuid: 400 prima di toccare il database', async () => {
    const res = await put(corpoValido(), 'non-un-uuid')
    expect(res.status).toBe(400)
    expect(h.letture).toHaveLength(0)
  })

  it('la coordinatrice non entra: 403, nessuna lettura', async () => {
    h.ruolo = 'coordinator'
    const res = await put(corpoValido())
    expect(res.status).toBe(403)
    expect(h.letture).toHaveLength(0)
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('quota già in contabilità: 409 QUOTA_GIA_IN_CONTABILITA', async () => {
    segnaRisponde({ esito: 'in_contabilita', pagamento_id: VOCE })
    const res = await put(corpoValido())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('QUOTA_GIA_IN_CONTABILITA')
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('il bambino sparito fra la lettura e la funzione: 404', async () => {
    segnaRisponde({ esito: 'non_trovato' })
    const res = await put(corpoValido())
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
  })

  it('manca la categoria di sistema «iscrizione»: incidente di configurazione, 500 generico e riga error', async () => {
    segnaRisponde({ esito: 'categoria_assente' })
    const res = await put(corpoValido())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(logCrm().some((r) => r.livello === 'error') || h.logErrore.mock.calls.length > 0).toBe(true)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('argomenti non validi per il database (22023): 400 e un avviso, non un 500', async () => {
    h.rpc.crm_quota_segna = () => ({ data: null, error: { code: '22023', message: 'importo non valido' } })
    const res = await put(corpoValido())
    expect(res.status).toBe(400)
    expect(h.logErrore).not.toHaveBeenCalled()
    expect(logCrm().some((r) => r.livello === 'warn')).toBe(true)
  })

  it('un altro errore del database: 500 CRM_OPERAZIONE_NON_RIUSCITA, con il testo solo nel log', async () => {
    h.rpc.crm_quota_segna = () => ({ data: null, error: { code: 'P0001', message: 'registra_incasso_voce non ha registrato' } })
    const res = await put(corpoValido())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('registra_incasso_voce')
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('tabelle assenti: 503 CRM_NON_INSTALLATO (database della CI non migrato)', async () => {
    h.errori = { crm_bambini: { code: 'PGRST205', message: 'Could not find the table' } }
    const res = await put(corpoValido())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it.each(['PGRST202', '42883'])('la funzione non c’è ancora (%s): 503 CRM_NON_INSTALLATO', async (code) => {
    h.rpc.crm_quota_segna = () => ({ data: null, error: { code, message: 'Could not find the function' } })
    const res = await put(corpoValido())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('una colonna della quota non c’è ancora (42703): 503, non un 500', async () => {
    h.errori = { crm_bambini: { code: '42703', message: 'column does not exist' } }
    const res = await put(corpoValido())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('non scrive mai da sé: tutte le scritture passano dalla funzione SQL', async () => {
    segnaOk()
    await put(corpoValido())
    expect(scritto('crm_bambini')).toHaveLength(0)
    expect(scritto('cassa_movimenti')).toHaveLength(0)
    expect(scritto('crm_eventi')).toHaveLength(0)
  })

  it('logga il successo con id, importo, metodo e anno, e mai il nome', async () => {
    segnaOk()
    await put(corpoValido())
    const riga = logCrm().find((r) => r.campi.esito === 'quota-segnata')
    expect(riga).toBeDefined()
    expect(riga!.livello).toBe('info')
    expect(riga!.campi).toMatchObject({ entita_id: B_LIBERO, importo: 150, metodo: 'contanti', anno: 2027 })
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('Bimbo Prova')
  })

  it('una quota già segnata e ora corretta lo dice: esito quota-corretta', async () => {
    segnaRisponde({ esito: 'ok', movimento_id: null, corretta: true, passaggio: null })
    await put(corpoValido())
    expect(logCrm().some((r) => r.campi.esito === 'quota-corretta')).toBe(true)
  })

  describe('il bambino è già un alunno: il passaggio in contabilità', () => {
    it('contanti: risponde con il passaggio, logga il successo del passaggio e notifica pagamento_registrato una volta', async () => {
      segnaOk(passaggioOk())
      const res = await put(corpoValido(), B_ALUNNO)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        data: {
          stato: 'in_contabilita',
          passaggio: { esito: 'ok', pagamentoId: VOCE, incassoId: INCASSO, voceNuova: true },
        },
      })
      const riga = logCrm().find((r) => r.campi.esito === 'quota-in-contabilita')
      expect(riga?.campi).toMatchObject({ entita_id: B_ALUNNO, pagamento_id: VOCE, voce_nuova: true })

      expect(h.notificaEvento).toHaveBeenCalledTimes(1)
      const [, params] = h.notificaEvento.mock.calls[0]
      expect(params).toMatchObject({
        tipo: 'pagamento_registrato',
        scuolaId: SEDE_A,
        alunnoIds: [ALUNNO],
        entitaTipo: 'pagamento',
        entitaId: VOCE,
        link: '/parent/pagamenti',
        debounce: true,
      })
      // né il nome del bambino né quello della famiglia nel testo che arriva al genitore
      expect(JSON.stringify(params)).not.toContain('Bimbo Prova')
      expect(JSON.stringify(params)).not.toContain('Famiglia Prova')
    })

    it('carta: nasce l’incasso, quindi la notifica parte', async () => {
      segnaOk({ ...passaggioOk(), metodo: 'carta' })
      await put(corpoValido({ metodo: 'carta' }), B_ALUNNO)
      expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    })

    it('bonifico: la voce nasce da pagare, nessun incasso, nessuna notifica', async () => {
      segnaOk(passaggioOk(null))
      const res = await put(corpoValido({ metodo: 'bonifico' }), B_ALUNNO)
      expect(res.status).toBe(200)
      expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('quota bloccata: stato «bloccata», il motivo nella risposta, nessuna notifica, un avviso nel log', async () => {
      segnaOk({ esito: 'bloccata', motivo: 'gia_pagata' })
      const res = await put(corpoValido(), B_ALUNNO)
      expect(await res.json()).toEqual({
        data: { stato: 'bloccata', passaggio: { esito: 'bloccata', motivo: 'gia_pagata' } },
      })
      expect(h.notificaEvento).not.toHaveBeenCalled()
      expect(logCrm().some((r) => r.livello === 'warn' && r.campi.esito === 'quota-bloccata:gia_pagata')).toBe(true)
    })

    it('bambino che non è ancora alunno: nessun passaggio e nessuna notifica', async () => {
      segnaOk(null)
      await put(corpoValido(), B_LIBERO)
      expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('la notifica rispetta la politica dei giorni passati: la data del pagamento è quella scelta', async () => {
      segnaOk(passaggioOk())
      await put(corpoValido({ giorno: '2026-10-20' }), B_ALUNNO)
      const [, params] = h.notificaEvento.mock.calls[0]
      // un pagamento di dieci giorni fa registrato dalla segreteria è una rettifica storica: al genitore non si scrive
      expect(params.operazione).toMatchObject({ giornoCompetenza: '2026-10-20', sopprimiGenitori: true })
    })

    it('un pagamento di oggi notifica i genitori', async () => {
      segnaOk(passaggioOk())
      await put(corpoValido(), B_ALUNNO)
      const [, params] = h.notificaEvento.mock.calls[0]
      expect(params.operazione).toMatchObject({ giornoCompetenza: OGGI, sopprimiGenitori: false })
    })

    it('se la notifica fallisce la richiesta riesce comunque, e l’errore è nel log', async () => {
      segnaOk(passaggioOk())
      h.notificaEvento.mockRejectedValue(new Error('coda non raggiungibile'))
      const res = await put(corpoValido(), B_ALUNNO)
      expect(res.status).toBe(200)
      expect(h.logEvento.mock.calls.some((c) => c[0] === 'notifica' && c[1] === 'error')).toBe(true)
    })
  })
})

describe('DELETE …/quota · togliere la quota', () => {
  it('chiama crm_quota_togli con bambino e utente, e risponde se ha stornato l’entrata di cassa', async () => {
    h.rpc.crm_quota_togli = () => ({ data: { esito: 'ok', stornato: true }, error: null })
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { stornato: true } })
    expect(chiamate('crm_quota_togli')).toEqual([
      { nome: 'crm_quota_togli', args: { p_bambino_id: B_LIBERO, p_eseguito_da: USER } },
    ])
    expect(logCrm().find((r) => r.campi.esito === 'quota-tolta')?.campi).toMatchObject({ entita_id: B_LIBERO, stornato: true })
  })

  it('niente da togliere: ripetere la richiesta è lecito (stornato falso)', async () => {
    h.rpc.crm_quota_togli = () => ({ data: { esito: 'ok', stornato: false }, error: null })
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { stornato: false } })
  })

  it('quota già in contabilità: 409 QUOTA_GIA_IN_CONTABILITA (è anche «È lo stesso pagamento» dopo il passaggio)', async () => {
    h.rpc.crm_quota_togli = () => ({ data: { esito: 'in_contabilita', pagamento_id: VOCE }, error: null })
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('QUOTA_GIA_IN_CONTABILITA')
  })

  it('bambino sparito: 404', async () => {
    h.rpc.crm_quota_togli = () => ({ data: { esito: 'non_trovato' }, error: null })
    const res = await del()
    expect(res.status).toBe(404)
  })

  it('bambino di un’altra sede o scheda: 404, la funzione non parte', async () => {
    expect((await del(B_SEDE_B)).status).toBe(404)
    expect((await del(B_INCOERENTE)).status).toBe(404)
    expect((await del(B_SEDE_B, SB)).status).toBe(403)
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('la coordinatrice non entra', async () => {
    h.ruolo = 'coordinator'
    expect((await del()).status).toBe(403)
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('tabelle o funzione assenti: 503 CRM_NON_INSTALLATO', async () => {
    h.rpc.crm_quota_togli = () => ({ data: null, error: { code: 'PGRST202', message: 'no function' } })
    const res = await del()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
    h.errori = { crm_bambini: { code: '42P01', message: 'no table' } }
    expect((await del()).status).toBe(503)
  })

  it('errore del database: 500 con il codice generico', async () => {
    h.rpc.crm_quota_togli = () => ({ data: null, error: { code: 'P0001', message: 'il movimento non si storna' } })
    const res = await del()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
  })
})

describe('POST …/quota/riprova · ritentare il passaggio in contabilità', () => {
  it('restituisce l’esito di crm_quota_passa e non notifica', async () => {
    h.rpc.crm_quota_passa = () => ({ data: passaggioOk(), error: null })
    const res = await riprova(B_ALUNNO)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { esito: 'ok', pagamentoId: VOCE, incassoId: INCASSO, voceNuova: true },
    })
    expect(chiamate('crm_quota_passa')).toEqual([
      { nome: 'crm_quota_passa', args: { p_bambino_id: B_ALUNNO, p_eseguito_da: USER } },
    ])
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(logCrm().some((r) => r.campi.esito === 'quota-in-contabilita')).toBe(true)
  })

  it.each([
    [{ esito: 'bloccata', motivo: 'supera_residuo' }, { esito: 'bloccata', motivo: 'supera_residuo' }],
    [{ esito: 'gia_in_contabilita', pagamento_id: VOCE }, { esito: 'gia_in_contabilita', pagamentoId: VOCE }],
    [{ esito: 'non_pronta' }, { esito: 'non_pronta' }],
    [{ esito: 'sede_diversa' }, { esito: 'sede_diversa' }],
    [{ esito: 'categoria_assente' }, { esito: 'categoria_assente' }],
  ])('l’esito %j risponde 200 con %j', async (dalDatabase, atteso) => {
    h.rpc.crm_quota_passa = () => ({ data: dalDatabase, error: null })
    const res = await riprova(B_ALUNNO)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: atteso })
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('bambino non trovato: 404', async () => {
    h.rpc.crm_quota_passa = () => ({ data: { esito: 'non_trovato' }, error: null })
    const res = await riprova(B_ALUNNO)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
  })

  it('funzione assente: 503 CRM_NON_INSTALLATO', async () => {
    h.rpc.crm_quota_passa = () => ({ data: null, error: { code: 'PGRST202', message: 'no function' } })
    const res = await riprova(B_ALUNNO)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('errore del database o eccezione: 500 con il codice generico, senza lanciare', async () => {
    h.rpc.crm_quota_passa = () => ({ data: null, error: { code: 'P0001', message: 'boom' } })
    const res = await riprova(B_ALUNNO)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')

    h.rpc.crm_quota_passa = () => {
      throw new Error('rete caduta')
    }
    const lanciata = await riprova(B_ALUNNO)
    expect(lanciata.status).toBe(500)
  })

  it('bambino di un’altra sede o scheda: 404/403 e la funzione non parte', async () => {
    expect((await riprova(B_SEDE_B)).status).toBe(404)
    expect((await riprova(B_INCOERENTE)).status).toBe(404)
    expect((await riprova(B_SEDE_B, SB)).status).toBe(403)
    expect(h.chiamateRpc).toHaveLength(0)
  })

  it('la coordinatrice non entra', async () => {
    h.ruolo = 'coordinator'
    expect((await riprova()).status).toBe(403)
    expect(h.chiamateRpc).toHaveLength(0)
  })
})

describe('PATCH del bambino · la vecchia spunta non scrive più niente', () => {
  const patch = (corpo: unknown, bambinoId = B_LIBERO) =>
    PATCH_BAMBINO(richiesta('PATCH', `/api/admin/crm/schede/${S1}/bambini/${bambinoId}`, corpo), ctx(S1, bambinoId))

  it('con solo { quotaSaldata: true } non scrive niente su crm_bambini', async () => {
    const res = await patch({ quotaSaldata: true })
    expect(res.status).toBe(400)
    expect(scritto('crm_bambini')).toHaveLength(0)
    expect(scritto('crm_eventi')).toHaveLength(0)
  })

  it('con { quotaSaldata, quotaSaldataIl } nemmeno', async () => {
    const res = await patch({ quotaSaldata: true, quotaSaldataIl: '2026-10-20' })
    expect(res.status).toBe(400)
    expect(scritto('crm_bambini')).toHaveLength(0)
  })

  it('insieme a un campo vero, scrive il campo vero e ignora la spunta', async () => {
    const res = await patch({ nome: 'Bimbo Prova Due', quotaSaldata: true, quotaSaldataIl: '2026-10-20' })
    expect(res.status).toBe(200)
    const scritture = scritto('crm_bambini')
    expect(scritture).toHaveLength(1)
    const valori = scritture[0].valori[0]
    expect(valori).toMatchObject({ nome: 'Bimbo Prova Due' })
    expect(valori).not.toHaveProperty('quota_saldata')
    expect(valori).not.toHaveProperty('quota_saldata_il')
    expect(valori).not.toHaveProperty('quota_segnata_da')
    const eventi = scritto('crm_eventi').flatMap((s) => s.valori)
    expect(eventi.some((e) => e.tipo === 'quota_segnata')).toBe(false)
  })
})
