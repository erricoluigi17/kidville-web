import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// `POST /api/avvisi` deve DICHIARARE la sede su cui pubblica (W2-B, R54/R69/R104).
//
// Fino al 2026-07-31 la route faceva `const scuolaId = auth.user.scuola_id ?? null`:
// la sede dell'avviso era la sede PRIMARIA dell'autore, non quella su cui stava
// lavorando. Con tre plessi il danno è completo e SILENZIOSO: la Direzione
// seleziona Aversa, sceglie «3 ANNI» (che esiste solo lì), pubblica — e la riga
// nasce a Giugliano. Da lì i destinatari sono `genitoriDiClassi(Giugliano, ['3
// ANNI'])`, cioè ZERO alunni; il feed del genitore filtra `.in('scuola_id',
// scuoleFigli)` e la famiglia di Aversa non lo vede mai; il cockpit filtra sulle
// sedi attive e nemmeno l'autore ritrova il proprio avviso. Risposta: 201.
//
// Metodo (regola trasversale del piano): niente `not.toBe(403)`. Si asserisce lo
// stato esatto E l'effetto sul database — che cosa è finito in `avvisi`, con
// quale `scuola_id`, e a chi è andata la notifica. Il finto client esegue davvero
// filtri e scritture, quindi «i destinatari sono quelli della sede giusta» è una
// proprietà verificata, non dichiarata.
//
// `@/lib/auth/scope`, `@/lib/avvisi/target-gate`, `@/lib/notifiche/destinatari` e
// `@/lib/anagrafiche/legami` girano VERI sul finto database: sono la catena che
// porta dalla sede risolta ai genitori da avvisare, ed è esattamente la catena
// che si era rotta.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const EDUCATOR = '22222222-2222-4222-8222-222222222222'
const GEN_A = '33333333-3333-4333-8333-333333333333'
const GEN_B = '44444444-4444-4444-8444-444444444444'
const GEN_B3 = '55555555-5555-4555-8555-555555555555'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ALU_B3 = 'b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb'

/** Nome di classe che esiste in ENTRAMBE le sedi: l'omonimia è la trappola. */
const OMONIMA = '2 ANNI'
/** Nome di classe che esiste SOLO nella sede B. */
const SOLO_B = '3 ANNI'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  notificaEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  /** Errori PostgREST iniettati per tabella (fixture W1-A). */
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
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

import { POST } from '@/app/api/avvisi/route'

const post = (body: unknown, cookie?: string) =>
  new NextRequest('http://localhost/api/avvisi', {
    method: 'POST',
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  // La Direzione è multi-plesso attraverso il ponte; l'educator no.
  utenti_scuole: [
    { utente_id: ADMIN, scuola_id: SEDE_A },
    { utente_id: ADMIN, scuola_id: SEDE_B },
  ],
  utenti: [
    { id: ADMIN, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    { id: EDUCATOR, ruolo: 'educator', role: 'educator', scuola_id: SEDE_A },
  ],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b3', scuola_id: SEDE_B, name: SOLO_B },
  ],
  // L'educator insegna nella «2 ANNI» della SUA sede (A).
  utenti_sezioni: [{ utente_id: EDUCATOR, section_id: 'sec-a', sections: { name: OMONIMA } }],
  alunni: [
    { id: ALU_A, scuola_id: SEDE_A, classe_sezione: OMONIMA, section_id: 'sec-a' },
    { id: ALU_B, scuola_id: SEDE_B, classe_sezione: OMONIMA, section_id: 'sec-b' },
    { id: ALU_B3, scuola_id: SEDE_B, classe_sezione: SOLO_B, section_id: 'sec-b3' },
  ],
  legame_genitori_alunni: [
    { alunno_id: ALU_A, genitore_id: GEN_A },
    { alunno_id: ALU_B, genitore_id: GEN_B },
    { alunno_id: ALU_B3, genitore_id: GEN_B3 },
  ],
  student_parents: [],
  parents: [],
  // Entrambe le sedi pubblicano: la config NON è la variabile sotto esame.
  admin_settings: [
    { scuola_id: SEDE_A, avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] } },
    { scuola_id: SEDE_B, avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] } },
  ],
  avvisi: [],
  audit_scritture_docente: [],
})

/** Le righe DAVVERO presenti in `avvisi` dopo la richiesta. */
const avvisiScritti = () => h.db.avvisi ?? []
/** Le scritture registrate su una tabella (accumulatore del finto client). */
const scrittureSu = (tabella: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)
/** Destinatari passati a `notificaEvento`, ordinati. */
const destinatari = (): string[] =>
  [...((h.notificaEvento.mock.calls[0]?.[1] as { utenteIds?: string[] })?.utenteIds ?? [])].sort()
const sedeNotificata = () =>
  (h.notificaEvento.mock.calls[0]?.[1] as { scuolaId?: string | null })?.scuolaId

const corpoAvviso = (extra: Record<string, unknown> = {}) => ({
  titolo: 'Uscita didattica',
  contenuto: 'Servono le adesioni entro venerdì.',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/avvisi — la sede si dichiara, non si deduce dall’autore', () => {
  it('Direzione multi-sede senza `scuola_id` e senza selezione ⇒ 400 e NIENTE in `avvisi`', async () => {
    const res = await POST(post(corpoAvviso({ target_scope: 'globale' })))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Specificare la sede')
    // L'effetto, non solo lo status: nessuna riga, nessuna scrittura, nessuna notifica.
    expect(avvisiScritti()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('`scuola_id` = sede B ⇒ l’avviso NASCE in B e la notifica va ai genitori di B', async () => {
    const res = await POST(
      post(corpoAvviso({ target_scope: 'classe', target_classes: [OMONIMA], scuola_id: SEDE_B })),
    )

    expect(res.status).toBe(201)
    expect(avvisiScritti()).toHaveLength(1)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_B)
    // La classe omonima non deve portare dentro la sede A: un solo destinatario.
    expect(sedeNotificata()).toBe(SEDE_B)
    expect(destinatari()).toEqual([GEN_B])
    // L'audit segue la stessa sede: senza, il registro racconta un'altra storia.
    expect(scrittureSu('audit_scritture_docente')[0]?.valori[0]?.scuola_id).toBe(SEDE_B)
  })

  it('il SedeSelector (cookie `sedi_attive`) decide quando il corpo tace', async () => {
    const res = await POST(
      post(corpoAvviso({ target_scope: 'classe', target_classes: [SOLO_B] }), `sedi_attive=${SEDE_B}`),
    )

    expect(res.status).toBe(201)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_B)
    expect(destinatari()).toEqual([GEN_B3])
  })

  it('classe che NON esiste nella sede dichiarata ⇒ 400, nessuna riga, nessuna notifica', async () => {
    // «3 ANNI» esiste solo in B: pubblicarla su A è l'errore che oggi risponde 201
    // e non arriva a nessuno.
    const res = await POST(
      post(corpoAvviso({ target_scope: 'classe', target_classes: [SOLO_B], scuola_id: SEDE_A })),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain(SOLO_B)
    expect(avvisiScritti()).toHaveLength(0)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('`scuola_id` di una sede NON accessibile ⇒ 403 e nessuna scrittura (mai fuori dal proprio perimetro)', async () => {
    // ⚠️ Era 400 fino al 2026-07-31, e il 400 arrivava per il motivo sbagliato:
    // `resolveScuolaScrittura` non NEGAVA la sede altrui, la DIMENTICAVA, e
    // finiva nel ramo «sede ambigua» solo perché questo utente ha più plessi.
    // Con un utente mono-sede la stessa strada dava 201, e l'avviso nasceva in
    // un plesso che nessuno aveva chiesto. Ora il diniego è esplicito.
    const res = await POST(
      post(corpoAvviso({ target_scope: 'globale', scuola_id: SEDE_C })),
    )

    expect(res.status).toBe(403)
    // `codice` accanto alla prosa: è quello che il client traduce nella lingua
    // dell'interfaccia (collaudo 2026-07-31, localizzazione F1).
    expect(await res.json()).toEqual({
      error: 'Sede non accessibile',
      codice: 'SEDE_NON_ACCESSIBILE',
    })
    expect(avvisiScritti()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('l’avviso `globale` di una sede resta di QUELLA sede: genitori di B, non di A', async () => {
    const res = await POST(post(corpoAvviso({ target_scope: 'globale', scuola_id: SEDE_B })))

    expect(res.status).toBe(201)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_B)
    expect(destinatari()).toEqual([GEN_B, GEN_B3])
  })

  it('educator con UNA sola sede: percorso felice invariato, nessun 400 da dichiarare', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: EDUCATOR, role: 'educator', scuola_id: SEDE_A } })

    const res = await POST(post(corpoAvviso({ target_scope: 'classe', target_classes: [OMONIMA] })))

    expect(res.status).toBe(201)
    expect(avvisiScritti()[0].scuola_id).toBe(SEDE_A)
    expect(destinatari()).toEqual([GEN_A])
  })

  it('solo i nomi di classe VALIDATI finiscono in `target_classes` (niente scarti non verificati)', async () => {
    const res = await POST(
      post(
        corpoAvviso({
          target_scope: 'classe',
          target_classes: [OMONIMA, OMONIMA, '  '],
          scuola_id: SEDE_B,
        }),
      ),
    )

    expect(res.status).toBe(201)
    expect(avvisiScritti()[0].target_classes).toEqual([OMONIMA])
  })

  it('un valore che non è un nome di classe ⇒ 400, invece di essere scartato in silenzio', async () => {
    // Fino al 2026-08-01 `target_classes` era `z.unknown()`: un numero in mezzo ai
    // nomi veniva buttato via da `classiTargetValide` e l'avviso si pubblicava lo
    // stesso, con 201. Comodo, e sbagliato: un client che manda un numero dove
    // vanno i nomi ha un difetto, e scartarlo in silenzio glielo nasconde —
    // pubblicando per giunta a un insieme di classi diverso da quello richiesto.
    // Ora lo schema lo rifiuta, ed è più severo di prima: l'intento del test qui
    // sopra («in tabella solo ciò che è stato verificato») vale a maggior ragione.
    const res = await POST(
      post(
        corpoAvviso({
          target_scope: 'classe',
          target_classes: [OMONIMA, 42],
          scuola_id: SEDE_B,
        }),
      ),
    )

    expect(res.status).toBe(400)
    expect(avvisiScritti(), 'nessuna riga scritta').toHaveLength(0)
  })

  it('lettura delle sezioni in errore ⇒ 500 PARLANTE, mai un 400 che incolpa l’operatore', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Senza il controllo del valore di
    // ritorno, «la query è rotta» diventerebbe «nessuna classe trovata» — cioè un
    // 400 che accusa chi pubblica di aver scelto una classe di un'altra sede.
    h.errori = { sections: { code: '42P01', message: 'relation "sections" does not exist' } }

    const res = await POST(
      post(corpoAvviso({ target_scope: 'classe', target_classes: [OMONIMA], scuola_id: SEDE_B })),
    )

    expect(res.status).toBe(500)
    // Il CORPO è la parte che conta: togliendo la guardia il codice esploderebbe
    // lo stesso in 500, ma dal `catch` esterno e con «Internal Server Error».
    // Asserire il solo status sarebbe un falso verde — la forma esatta dei due
    // test smascherati il 30/07.
    expect((await res.json()).error).toBe('Verifica delle classi destinatarie non riuscita')
    expect(avvisiScritti()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('403 senza il gate docente: non si legge e non si scrive nulla', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })

    const res = await POST(post(corpoAvviso({ target_scope: 'globale', scuola_id: SEDE_A })))

    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
    expect(h.scritture).toHaveLength(0)
  })
})
