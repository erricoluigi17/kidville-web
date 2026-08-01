import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// PUT /api/avvisi/[id] — il gate di sede sul TARGET esiste anche in MODIFICA.
//
// IL DIFETTO, trovato il 2026-08-01 mentre si indagava perché due avvisi veri in
// produzione non fossero arrivati a nessuno.
//
// Il 30 luglio `POST /api/avvisi` ha ricevuto il gate `classiMancantiNellaSede`:
// ogni nome di classe deve esistere nella sede su cui si pubblica. Nasceva dal
// fatto che il nome-classe ha smesso di essere una chiave univoca quando i plessi
// sono diventati tre — «2 ANNI» esiste a Giugliano e ad Aversa — e senza quel
// controllo si pubblica a una classe che sta in un'altra sede, con l'avviso che
// non arriva a nessuno e il server che risponde 201.
//
// **Il PUT non l'ha mai avuto.** Ha il gate di RUOLO (`verificaTargetAvvisoDocente`,
// «un educator riassegna solo alle proprie classi») e si ferma lì: poi scrive
// `target_classes` GREZZO, l'array così com'è arrivato dal client — mentre il POST
// scrive `classiTarget`, l'insieme validato e deduplicato.
//
// È il difetto C8 del piano di correzione, di nuovo: «il ramo del cookie non ha
// avuto lo stesso trattamento del ramo dichiarato». Qui è il ramo della MODIFICA a
// non aver avuto il trattamento del ramo della CREAZIONE. Chiudere una porta e
// lasciare aperta quella accanto non è mezza correzione: è nessuna correzione, e
// per giunta con l'aria di essere fatta.
//
// PERCHÉ SI VEDE POCO. Un avviso riassegnato a una classe inesistente risponde
// **200 con la riga aggiornata**: l'operatore vede il successo. Il silenzio arriva
// dopo, dalla parte dei genitori, dove nessuno lo collega alla modifica. In
// produzione due avvisi («Gita al parco di Villa Comunale», «Laboratorio di lettura
// in giardino») hanno in `target_classes` l'UUID della sezione invece del nome: 10
// alunni in sezione, 10 genitori agganciati, **0 destinatari raggiunti**.
//
// METODO. L'asserzione che conta è sulla MUTAZIONE, non sullo status: un 400 con
// l'UPDATE già partito sarebbe un falso verde. Ogni diniego ha accanto il suo
// CONTROLLO POSITIVO sulla stessa sede — un gate che nega tutto passerebbe un test
// fatto di soli 400, e sarebbe il difetto opposto (l'avviso non si modifica più).
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const AVVISO_A = 'cccccccc-0000-4000-8000-00000000000c'

/** Nome di classe che esiste in ENTRAMBE le sedi: l'omonimia è la trappola. */
const OMONIMA = '2 ANNI'
/** Nome di classe che esiste SOLO nella sede B. */
const SOLO_B = '3 ANNI'
/** L'ID della sezione di sede A. È il valore che in produzione è finito in tabella. */
const ID_SEZIONE_A = 'sec-a'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente,
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({
  assertAvvisoInScope: h.assertAvvisoInScope,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori,
      }),
  }
})

import { PUT } from '@/app/api/avvisi/[id]/route'

const put = (body: unknown, id = AVVISO_A) =>
  PUT(
    new NextRequest(`http://localhost/api/avvisi/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

const dbBase = (): DBFinto => ({
  utenti: [{ id: ADMIN, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A }],
  utenti_scuole: [{ utente_id: ADMIN, scuola_id: SEDE_A }],
  sections: [
    { id: ID_SEZIONE_A, scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b3', scuola_id: SEDE_B, name: SOLO_B },
  ],
  avvisi: [
    {
      id: AVVISO_A,
      author_id: ADMIN,
      titolo: 'Uscita didattica',
      contenuto: 'Servono le adesioni entro venerdì.',
      tipo: 'presa_visione',
      target_scope: 'classe',
      target_classes: [OMONIMA],
      scadenza: null,
      attachment_url: null,
      scuola_id: SEDE_A,
    },
  ],
  audit_scritture_docente: [],
})

/** Il `target_classes` DAVVERO in tabella dopo la richiesta: la prova che conta. */
const targetInTabella = () =>
  (h.db.avvisi ?? []).find((a) => a.id === AVVISO_A)?.target_classes
/** Gli UPDATE davvero eseguiti su `avvisi`. */
const updateAvvisi = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'avvisi' && s.operazione === 'update')

const corpo = (extra: Record<string, unknown> = {}) => ({
  titolo: 'Uscita didattica',
  contenuto: 'Servono le adesioni entro venerdì.',
  tipo: 'presa_visione',
  target_scope: 'classe',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  // I due gate che il PUT ha GIÀ: qui non sono la variabile sotto esame.
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.assertAvvisoInScope.mockResolvedValue(null)
})

describe('PUT /api/avvisi/[id] — in modifica il target passa dallo stesso gate della creazione', () => {
  it('CONTROLLO POSITIVO: una classe della PROPRIA sede ⇒ 200 e la riga cambia davvero', async () => {
    // Senza questo, tutto il resto del file starebbe certificando un gate che
    // nega a chiunque — cioè un avviso che non si può più modificare.
    const res = await put(corpo({ target_classes: [OMONIMA] }))
    expect(res.status).toBe(200)
    expect(updateAvvisi()).toHaveLength(1)
    expect(targetInTabella()).toEqual([OMONIMA])
  })

  it("l'ID di una sezione al posto del NOME ⇒ 400, e in tabella non entra", async () => {
    // È il caso misurato in produzione: `target_classes: ['<uuid>']`. Il confronto
    // della consegna è con `alunni.classe_sezione`, che contiene il NOME: un id
    // non corrisponde a nessuno, e l'avviso sparisce senza che niente sia rosso.
    const res = await put(corpo({ target_classes: [ID_SEZIONE_A] }))
    expect(res.status).toBe(400)
    expect(updateAvvisi(), 'nessun UPDATE deve partire').toHaveLength(0)
    expect(targetInTabella(), 'la riga resta com’era').toEqual([OMONIMA])
  })

  it('una classe che esiste SOLO in un’altra sede ⇒ 400, e in tabella non entra', async () => {
    const res = await put(corpo({ target_classes: [SOLO_B] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty('error')
    expect(updateAvvisi()).toHaveLength(0)
    expect(targetInTabella()).toEqual([OMONIMA])
  })

  it('l’omonima dell’altra sede è AMMESSA: è il nome che conta, e nella sede c’è', async () => {
    // L'omonimia non va confusa con l'errore: «2 ANNI» esiste anche in sede A, e
    // l'avviso è di sede A. Un gate che negasse qui starebbe leggendo la sede
    // sbagliata — ed è il difetto che ha aperto tutto l'audit, al contrario.
    const res = await put(corpo({ target_classes: [OMONIMA] }))
    expect(res.status).toBe(200)
    expect(targetInTabella()).toEqual([OMONIMA])
  })

  it('`classe` con lista vuota ⇒ 400, come nel POST (niente degrado implicito a globale)', async () => {
    const res = await put(corpo({ target_classes: [] }))
    expect(res.status).toBe(400)
    expect(updateAvvisi()).toHaveLength(0)
  })

  it('in tabella finisce l’insieme VALIDATO: niente duplicati, niente stringhe vuote', async () => {
    // Il POST archivia `classiTarget`, non l'array grezzo, «perché validare una
    // lista e scriverne un'altra rende il gate una formalità». Vale qui uguale.
    const res = await put(corpo({ target_classes: [OMONIMA, OMONIMA, '  ', ''] }))
    expect(res.status).toBe(200)
    expect(targetInTabella()).toEqual([OMONIMA])
  })

  it('un avviso GLOBALE resta modificabile senza classi', async () => {
    const res = await put(corpo({ target_scope: 'globale', target_classes: [] }))
    expect(res.status).toBe(200)
    expect(updateAvvisi()).toHaveLength(1)
  })

  it('lettura delle sezioni in errore ⇒ 500, mai un 400 che incolpa l’operatore', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Se non lo si guarda, un guasto di
    // lettura diventa «nessuna classe trovata», cioè un 400 che accusa chi sta
    // lavorando di un errore che non ha commesso.
    h.errori = { sections: { code: '42501', message: 'permission denied' } }
    const res = await put(corpo({ target_classes: [OMONIMA] }))
    expect(res.status).toBe(500)
    expect(updateAvvisi()).toHaveLength(0)
    // E il messaggio grezzo del database non torna al client.
    expect(JSON.stringify(await res.json())).not.toContain('permission denied')
  })
})
