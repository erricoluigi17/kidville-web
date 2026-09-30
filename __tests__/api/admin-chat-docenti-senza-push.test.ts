import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// ════════════════════════════════════════════════════════════════════════════
// GET /api/admin/chat/docenti-senza-push — CHI NON RICEVE NIENTE, E QUANTO
// ════════════════════════════════════════════════════════════════════════════
//
// «I messaggi dei genitori non arrivano alle maestre» (segnalazione del
// 2026-09-29). Fra le cause misurate: le docenti che hanno negato il permesso
// delle notifiche non ricevono NESSUNA push, e nessuno lo sa. Una maestra su
// Android ha ricevuto 137 messaggi in 30 giorni senza una sola notifica.
//
// `AvvisoNotificheDocente` lo mostra alla maestra nella sua home; questa route lo dice
// alla DIREZIONE, che può intervenire di persona. Ciò che si collauda qui è
// quello che il difetto originale ha insegnato: un elenco che sbaglia PER
// DIFETTO (esclude chi doveva comparire) o PER ECCESSO (include chi ha già i
// dispositivi, o una docente di un'altra sede) non è meno inutile del silenzio
// che sostituisce.
//
// La popolazione sono le `educator` NON ARCHIVIATE delle sedi nel perimetro.
// NON si filtra `utenti.attivo`: è una casella che nessun gate legge e che in
// produzione è a `false` su nove docenti con accessi recenti, quindi filtrarci
// sopra farebbe sparire dall'elenco proprio le maestre vive che serve trovare.
// L'archiviazione invece esclude, perché archiviare CANCELLA le
// `push_subscriptions`: senza quel filtro ogni archiviata comparirebbe qui per
// sempre.

const D_SENZA = 'd1d1d1d1-0000-4000-8000-000000000001'
const D_CON_PUSH = 'd2d2d2d2-0000-4000-8000-000000000002'
const D_ARCHIVIATA = 'd3d3d3d3-0000-4000-8000-000000000003'
const D_ATTIVO_FALSE = 'd4d4d4d4-0000-4000-8000-000000000004'
const D_ALTRA_SEDE = 'd5d5d5d5-0000-4000-8000-000000000005'
const D_TANTI_NON_LETTI = 'd6d6d6d6-0000-4000-8000-000000000006'
const SEGRETERIA = 'd7d7d7d7-0000-4000-8000-000000000007'
const GENITORE = '9a9a9a9a-0000-4000-8000-00000000000e'
const DIRIGENTE = 'aaaa1111-0000-4000-8000-00000000000f'

const T_CON_PUSH = 'f5f5f5f5-0000-4000-8000-000000000005'
const T_SENZA = 'f1f1f1f1-0000-4000-8000-000000000001'
const T_SENZA_2 = 'f2f2f2f2-0000-4000-8000-000000000002'
const T_TANTI = 'f3f3f3f3-0000-4000-8000-000000000003'
const T_ALTRA_SEDE = 'f4f4f4f4-0000-4000-8000-000000000004'
const ALUNNO_A = 'b1b1b1b1-0000-4000-8000-000000000001'
const ALUNNO_B = 'b2b2b2b2-0000-4000-8000-000000000002'

/** Il testo di un messaggio vero non deve uscire da questa route, mai. */
const SEGRETO = 'MIO-FIGLIO-HA-LA-FEBBRE-NON-DEVE-USCIRE-DA-QUI'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  /**
   * Ogni `select`: tabella, colonne e se era una HEAD-query (`head: true`, cioè
   * «contami le righe e non mandarmene nessuna»). Il finto client registra solo
   * le tabelle, e la differenza fra contare e trasferire è il cuore di due
   * proprietà: le colonne dei messaggi e il modo in cui si contano i non letti.
   */
  selezioni: [] as { tabella: string; colonne: string; head: boolean; count?: string }[],
  /**
   * Errore iniettato SOLO sulla query dei non letti (quella con
   * `.is('read_at', null)`). `errori` del finto client colpisce per
   * tabella+operazione, e le due letture dei messaggi sono entrambe
   * `chat_messages:select`: senza questo, il ramo d'errore della SECONDA non è
   * raggiungibile da nessun test — la prima fallisce prima.
   */
  erroreSoloNonLetti: null as { code: string; message?: string } | null,
  /**
   * Errore iniettato SOLO sul PRIMO insert nel registro: `errori` del finto
   * client colpisce tutti gli insert di quella tabella, e «la prima riga cade,
   * le altre si scrivono» non sarebbe rappresentabile.
   */
  erroreSoloPrimoInsert: null as { code: string; message?: string } | null,
}))

/** Una catena di query che risponde SEMPRE con questo errore. */
function catenaRotta(errore: { code: string; message?: string }) {
  const rotta: Record<string, unknown> = {}
  const passa = () => rotta
  for (const m of ['select', 'eq', 'in', 'is', 'neq', 'gte', 'lte', 'order', 'range', 'limit']) rotta[m] = passa
  rotta.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: errore }).then(ok)
  return rotta
}

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Il logger si SPIA, non si sostituisce: `withRoute` ne usa altre funzioni, e un
// mock piatto del modulo intero le farebbe sparire (il difetto sarebbe nel test,
// non nella route).
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: h.logErrore, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Il finto client registra le TABELLE lette, non le colonne, e inietta gli
  // errori per tabella+operazione. Qui si avvolge la CATENA di query per due
  // cose che senza wrapper nessun test potrebbe vedere:
  //  · le COLONNE di ogni `select` («di un messaggio non si legge il
  //    `content`» è una promessa sulla privacy, e una promessa che nessuno
  //    guarda è una frase in un commento);
  //  · un errore sulla SOLA query dei non letti, che è `chat_messages:select`
  //    esattamente come quella dei ricevuti.
  //
  // ⚠️ IL WRAPPER SI RIAPPLICA A OGNI ANELLO. I metodi del finto restituiscono
  // il proprio oggetto interno, non questo Proxy: avvolgendo solo `from()` la
  // catena sfuggiva dopo il primo `.select()`, e l'iniezione su `.is()` — che
  // arriva terza — non scattava mai. Il test diventava verde per il motivo
  // sbagliato: nessun errore iniettato, nessun ramo esercitato.
  type Catena = Record<string, unknown>
  const avvolgi = (catena: Catena, tabella: string): Catena =>
    new Proxy(catena, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r)
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          if (p === 'select') {
            const opts = (args[1] ?? {}) as { head?: boolean; count?: string }
            h.selezioni.push({
              tabella,
              colonne: String(args[0] ?? ''),
              head: opts.head === true,
              count: opts.count,
            })
          }
          if (p === 'is' && h.erroreSoloNonLetti && args[0] === 'read_at') {
            return catenaRotta(h.erroreSoloNonLetti)
          }
          if (p === 'insert' && h.erroreSoloPrimoInsert) {
            const primo = h.erroreSoloPrimoInsert
            h.erroreSoloPrimoInsert = null
            return catenaRotta(primo)
          }
          const out = (v as (...a: unknown[]) => unknown).apply(t, args)
          // Solo gli anelli della catena si riavvolgono: `then`/`single`
          // restituiscono una Promise, e quella passa intatta.
          return out === t ? avvolgi(t, tabella) : out
        }
      },
    })

  return {
    createAdminClient: async () => {
      const vero = creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture })
      return new Proxy(vero, {
        get(t, prop, ricevitore) {
          if (prop !== 'from') return Reflect.get(t, prop, ricevitore)
          return (tabella: string) =>
            avvolgi((t as unknown as { from: (s: string) => Catena }).from(tabella), tabella)
        },
      }) as never
    },
  }
})

import { GET } from '@/app/api/admin/chat/docenti-senza-push/route'

const req = (qs = '') => new NextRequest(`http://localhost/api/admin/chat/docenti-senza-push${qs}`)

/** Un istante dentro la finestra dei 30 giorni. */
const recente = (oreIndietro: number) =>
  new Date(Date.now() - oreIndietro * 3600_000).toISOString()
/** Un istante FUORI dalla finestra: 40 giorni fa. */
const vecchio = () => new Date(Date.now() - 40 * 86_400_000).toISOString()
/** Giorni indietro, per i due messaggi ai BORDI della finestra (29 e 31). */
const giorniFa = (g: number) => new Date(Date.now() - g * 86_400_000).toISOString()

const dbBase = (): DBFinto => ({
  utenti: [
    { id: D_SENZA, nome: 'Anna', cognome: 'Bianchi', ruolo: 'educator', scuola_id: SEDE_A, attivo: true, archiviato_il: null },
    { id: D_CON_PUSH, nome: 'Bruna', cognome: 'Conti', ruolo: 'educator', scuola_id: SEDE_A, attivo: true, archiviato_il: null },
    { id: D_ARCHIVIATA, nome: 'Carla', cognome: 'Dini', ruolo: 'educator', scuola_id: SEDE_A, attivo: true, archiviato_il: '2026-09-20T10:00:00.000Z' },
    { id: D_ATTIVO_FALSE, nome: 'Dora', cognome: 'Esposito', ruolo: 'educator', scuola_id: SEDE_A, attivo: false, archiviato_il: null },
    { id: D_ALTRA_SEDE, nome: 'Elena', cognome: 'Fabbri', ruolo: 'educator', scuola_id: SEDE_B, attivo: true, archiviato_il: null },
    { id: D_TANTI_NON_LETTI, nome: 'Fiora', cognome: 'Greco', ruolo: 'educator', scuola_id: SEDE_A, attivo: true, archiviato_il: null },
    { id: SEGRETERIA, nome: 'Gina', cognome: 'Hidalgo', ruolo: 'segreteria', scuola_id: SEDE_A, attivo: true, archiviato_il: null },
    { id: GENITORE, nome: 'Ida', cognome: 'Lupo', ruolo: 'genitore', scuola_id: SEDE_A, attivo: true, archiviato_il: null },
  ],
  // `D_CON_PUSH` ha un dispositivo: le notifiche le riceve, e dall'elenco esce.
  push_subscriptions: [
    { id: 'p1', utente_id: D_CON_PUSH, endpoint: 'https://esempio/1', platform: 'android' },
  ],
  alunni: [
    { id: ALUNNO_A, scuola_id: SEDE_A },
    { id: ALUNNO_B, scuola_id: SEDE_B },
  ],
  chat_threads: [
    { id: T_SENZA, teacher_id: D_SENZA, parent_id: GENITORE, student_id: ALUNNO_A, alunni: { scuola_id: SEDE_A } },
    { id: T_SENZA_2, teacher_id: D_SENZA, parent_id: GENITORE, student_id: ALUNNO_A, alunni: { scuola_id: SEDE_A } },
    { id: T_TANTI, teacher_id: D_TANTI_NON_LETTI, parent_id: GENITORE, student_id: ALUNNO_A, alunni: { scuola_id: SEDE_A } },
    { id: T_ALTRA_SEDE, teacher_id: D_ALTRA_SEDE, parent_id: GENITORE, student_id: ALUNNO_B, alunni: { scuola_id: SEDE_B } },
    // La maestra che HA il dispositivo: non è nell'elenco, e le sue
    // conversazioni non devono entrare in nessun conteggio.
    { id: T_CON_PUSH, teacher_id: D_CON_PUSH, parent_id: GENITORE, student_id: ALUNNO_A, alunni: { scuola_id: SEDE_A } },
  ],
  chat_messages: [
    // D_SENZA: tre dal genitore dentro i 30 giorni, due ancora da leggere.
    { id: 'm1', thread_id: T_SENZA, sender_id: GENITORE, content: SEGRETO, read_at: null, created_at: recente(2) },
    { id: 'm2', thread_id: T_SENZA, sender_id: GENITORE, content: 'e oggi?', read_at: null, created_at: recente(3) },
    { id: 'm3', thread_id: T_SENZA_2, sender_id: GENITORE, content: 'grazie', read_at: recente(1), created_at: recente(4) },
    // Scritto DA LEI: non è un messaggio ricevuto.
    { id: 'm4', thread_id: T_SENZA, sender_id: D_SENZA, content: 'buongiorno', read_at: null, created_at: recente(1) },
    // Fuori dalla finestra dei 30 giorni: NON è un «ricevuto» recente, ma è
    // ancora DA LEGGERE — e un messaggio mai letto non scade.
    { id: 'm5', thread_id: T_SENZA, sender_id: GENITORE, content: 'vecchio', read_at: null, created_at: vecchio() },
    // ── I DUE BORDI DELLA FINESTRA, entrambi GIÀ LETTI ────────────────────
    // Letti di proposito: così spostano soltanto il conteggio dei ricevuti, e
    // la finestra si misura senza che l'arretrato interferisca. Con la finestra
    // in ORE invece che in giorni, `m6` (29 giorni) esce dal conteggio e questo
    // test diventa rosso.
    { id: 'm6', thread_id: T_SENZA, sender_id: GENITORE, content: 'quasi un mese', read_at: recente(1), created_at: giorniFa(29) },
    { id: 'm7', thread_id: T_SENZA, sender_id: GENITORE, content: 'oltre il mese', read_at: recente(1), created_at: giorniFa(31) },
    // D_TANTI_NON_LETTI: cinque dal genitore, tutti da leggere.
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`, thread_id: T_TANTI, sender_id: GENITORE, content: 'ciao', read_at: null, created_at: recente(5 + i),
    })),
    // Sull'altra sede: non deve entrare in nessun conteggio.
    { id: 'x1', thread_id: T_ALTRA_SEDE, sender_id: GENITORE, content: 'altra sede', read_at: null, created_at: recente(2) },
    // Della maestra CON dispositivo: senza `.in('teacher_id', …)` questi due
    // finirebbero nel conteggio di sede scritto nel registro.
    { id: 'p1m', thread_id: T_CON_PUSH, sender_id: GENITORE, content: 'a chi le riceve', read_at: null, created_at: recente(2) },
    { id: 'p2m', thread_id: T_CON_PUSH, sender_id: GENITORE, content: 'a chi le riceve', read_at: null, created_at: recente(3) },
  ],
  utenti_scuole: [],
  chat_vigilanza_accessi: [],
})

const righeRegistro = () => h.scritture.filter((s) => s.tabella === 'chat_vigilanza_accessi')
const rigaRegistro = (i = 0) => {
  const v = righeRegistro()[i].valori as Record<string, unknown> | Record<string, unknown>[]
  return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>
}

const corpo = async (res: Response) => (await res.json()) as {
  success?: boolean
  data?: { id: string; nome: string; ricevuti30g: number; nonLetti: number }[]
  totale?: number
  docentiTotali?: number
  codice?: string
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.selezioni = []
  h.erroreSoloNonLetti = null
  h.erroreSoloPrimoInsert = null
  h.errori = {}
  // Direzione (`coordinator`): la sede è una, quella dell'account.
  h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'coordinator', scuola_id: SEDE_A } })
})

describe('GET /api/admin/chat/docenti-senza-push — il gate', () => {
  it('il gate è quello della DIREZIONE: `requireStaff` riceve i ruoli, non la lista predefinita', async () => {
    await GET(req())
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })

  it('401 di sessione: la risposta del gate passa intatta e non si legge niente', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.tabelle).toEqual([])
  })

  it('403 per chi non è Direzione (segreteria, docente): nessuna tabella letta', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
  })

  it('una sede fuori dal proprio perimetro viene RIFIUTATA, non ignorata', async () => {
    const res = await GET(req(`?scuolaId=${SEDE_B}`))
    expect(res.status).toBe(403)
    expect((await corpo(res)).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('`scuolaId` malformato: 400 di validazione, prima di qualunque lettura', async () => {
    const res = await GET(req('?scuolaId=non-un-uuid'))
    expect(res.status).toBe(400)
    expect(h.tabelle).toEqual([])
  })
})

describe('GET /api/admin/chat/docenti-senza-push — chi compare', () => {
  it('compaiono SOLO le docenti non archiviate della propria sede senza nessun dispositivo', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const b = await corpo(res)
    expect(b.success).toBe(true)
    expect(b.data?.map((d) => d.id)).toEqual([D_TANTI_NON_LETTI, D_SENZA, D_ATTIVO_FALSE])
    expect(b.totale).toBe(3)
  })

  it('chi ha almeno un dispositivo NON compare', async () => {
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.id)).not.toContain(D_CON_PUSH)
  })

  it('una docente ARCHIVIATA non compare, nemmeno senza dispositivi', async () => {
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.id)).not.toContain(D_ARCHIVIATA)
  })

  it('una docente con `attivo = false` COMPARE: quella colonna non è un licenziamento', async () => {
    // `predicati-ruolo.ts` lo scrive per esteso: nessun gate legge `attivo`, e
    // in produzione è a `false` su account vivi — Direzione compresa. Escluderla
    // farebbe sparire dall'elenco una maestra che riceve messaggi e non riceve
    // notifiche, cioè il caso per cui l'elenco esiste. Chi non lavora più qui si
    // riconosce da `archiviato_il`, ed è il test qui sopra.
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.id)).toContain(D_ATTIVO_FALSE)
  })

  it('una docente di un\'ALTRA SEDE non compare (né lei né i suoi messaggi)', async () => {
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.id)).not.toContain(D_ALTRA_SEDE)
  })

  it('segreteria e genitori non sono docenti: non entrano nell\'elenco né nel totale', async () => {
    const b = await corpo(await GET(req()))
    const ids = b.data?.map((d) => d.id) ?? []
    expect(ids).not.toContain(SEGRETERIA)
    expect(ids).not.toContain(GENITORE)
    // Le educator non archiviate della sede sono quattro: D_SENZA, D_CON_PUSH,
    // D_ATTIVO_FALSE, D_TANTI. L'archiviata resta fuori.
    expect(b.docentiTotali).toBe(4)
  })

  it('il nome è quello che mostra la vigilanza: «Cognome Nome»', async () => {
    const b = await corpo(await GET(req()))
    expect(b.data?.find((d) => d.id === D_SENZA)?.nome).toBe('Bianchi Anna')
  })

  it('NESSUNA docente nel perimetro: elenco vuoto, log a zero, nessun registro', async () => {
    h.db.utenti = h.db.utenti.filter((u) => u.ruolo !== 'educator')
    const res = await GET(req())
    expect(res.status).toBe(200)
    const b = await corpo(res)
    expect(b.data).toEqual([])
    expect(b.docentiTotali).toBe(0)
    expect(righeRegistro()).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalledWith(
      'chat',
      'info',
      expect.objectContaining({ esito: 'ok', docenti: 0, senza_push: 0 }),
    )
    // Nessuna docente ⇒ niente da cercare: i messaggi non si toccano.
    expect(h.tabelle).not.toContain('chat_messages')
  })

  it('nessuna docente senza dispositivi: elenco vuoto e 200', async () => {
    h.db.push_subscriptions = h.db.utenti.map((u, i) => ({ id: `p${i}`, utente_id: u.id, endpoint: `https://esempio/${i}` }))
    const b = await corpo(await GET(req()))
    expect(b.data).toEqual([])
    expect(b.totale).toBe(0)
    expect(b.docentiTotali).toBe(4)
  })

  it('la Direzione multi-sede vede le docenti di TUTTE le sue sedi', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'admin', scuola_id: SEDE_A } })
    h.db.utenti_scuole = [
      { utente_id: DIRIGENTE, scuola_id: SEDE_A },
      { utente_id: DIRIGENTE, scuola_id: SEDE_B },
    ]
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.id)).toContain(D_ALTRA_SEDE)
  })
})

describe('GET /api/admin/chat/docenti-senza-push — i conteggi', () => {
  it('conta i messaggi RICEVUTI negli ultimi 30 giorni, esclusi i propri e i più vecchi', async () => {
    const b = await corpo(await GET(req()))
    const riga = b.data?.find((d) => d.id === D_SENZA)
    // m1, m2, m3 e m6 (29 giorni): quattro. Non m4 (scritto da lei), non m5 (40
    // giorni) e non m7 (31 giorni).
    expect(riga?.ricevuti30g).toBe(4)
  })

  it('i NON LETTI sono solo quelli con `read_at` nullo', async () => {
    const b = await corpo(await GET(req()))
    // m1, m2 (recenti) e m5 (40 giorni fa): tre. Non m3, che è già letto, e non
    // m4, che l'ha scritto lei.
    expect(b.data?.find((d) => d.id === D_SENZA)?.nonLetti).toBe(3)
  })

  it('i NON LETTI NON hanno finestra: quello di 40 giorni fa conta ancora', async () => {
    // Ricavare i non letti dalla stessa query dei ricevuti farebbe sparire m5 —
    // mai letto, quaranta giorni fa — dal numero che ORDINA l'elenco, cioè
    // toglierebbe peso proprio alla maestra con l'arretrato più vecchio.
    // «Ricevuti» misura il traffico recente, «non letti» l'arretrato: due
    // domande, due letture.
    const b = await corpo(await GET(req()))
    const riga = b.data?.find((d) => d.id === D_SENZA)
    expect(riga?.ricevuti30g).toBe(4)
    expect(riga?.nonLetti).toBe(3)

    // La controprova: se m5 fosse LETTO, i non letti scenderebbero a due.
    h.db.chat_messages = (h.db.chat_messages as Record<string, unknown>[]).map((m) =>
      m.id === 'm5' ? { ...m, read_at: recente(1) } : m,
    )
    const b2 = await corpo(await GET(req()))
    expect(b2.data?.find((d) => d.id === D_SENZA)?.nonLetti).toBe(2)
  })

  it('i messaggi si sommano su TUTTE le conversazioni della docente', async () => {
    // D_SENZA ha due thread: uno con m1, m2, m6, l'altro con m3.
    const b = await corpo(await GET(req()))
    expect(b.data?.find((d) => d.id === D_SENZA)?.ricevuti30g).toBe(4)
  })

  it('l\'elenco è ordinato per non letti DECRESCENTI', async () => {
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.nonLetti)).toEqual([5, 3, 0])
  })

  it('una conversazione su un bambino di un\'ALTRA sede non entra nei conteggi', async () => {
    // La docente è nel perimetro, il bambino no: `chat_threads` non ha
    // `scuola_id` — la sede è dell'alunno — e senza il filtro sul join i
    // messaggi di un altro plesso si sommerebbero al suo conteggio.
    h.db.chat_threads = [
      ...h.db.chat_threads,
      { id: 'f9f9f9f9-0000-4000-8000-000000000009', teacher_id: D_SENZA, parent_id: GENITORE, student_id: ALUNNO_B, alunni: { scuola_id: SEDE_B } },
    ]
    h.db.chat_messages = [
      ...h.db.chat_messages,
      { id: 'y1', thread_id: 'f9f9f9f9-0000-4000-8000-000000000009', sender_id: GENITORE, content: 'altra sede', read_at: null, created_at: recente(2) },
      { id: 'y2', thread_id: 'f9f9f9f9-0000-4000-8000-000000000009', sender_id: GENITORE, content: 'altra sede', read_at: null, created_at: recente(3) },
    ]
    const b = await corpo(await GET(req()))
    expect(b.data?.find((d) => d.id === D_SENZA)).toMatchObject({ ricevuti30g: 4, nonLetti: 3 })
  })

  it('a pari non letti e pari ricevuti, l\'ordine è alfabetico', async () => {
    // Senza uno spareggio stabile l'ordine di due righe identiche lo decide
    // l'ordine di arrivo dal database, che non è garantito: la stessa schermata
    // ricaricata due volte mostrerebbe le maestre in ordine diverso.
    h.db.utenti = [
      { id: D_SENZA, nome: 'Anna', cognome: 'Zeta', ruolo: 'educator', scuola_id: SEDE_A, archiviato_il: null },
      { id: D_TANTI_NON_LETTI, nome: 'Bruna', cognome: 'Alfa', ruolo: 'educator', scuola_id: SEDE_A, archiviato_il: null },
    ]
    h.db.chat_threads = []
    h.db.chat_messages = []
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.nome)).toEqual(['Alfa Bruna', 'Zeta Anna'])
  })

  it('`alunni` restituito come ELENCO: la sede si legge comunque', async () => {
    // PostgREST serve il nodo annidato come oggetto per una relazione to-one e
    // come array quando la deduce to-many. Se la forma cambiasse, un accesso a
    // `.scuola_id` sull'array darebbe `undefined` in silenzio — e la riga di
    // registro uscirebbe senza sede, cioè invisibile nella scheda che la mostra.
    h.db.chat_threads = (h.db.chat_threads as Record<string, unknown>[]).map((t) => ({
      ...t,
      alunni: [t.alunni],
    }))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(rigaRegistro()).toMatchObject({ scuola_id: SEDE_A, n_messaggi: 9 })
  })

  it('una docente senza nessuna conversazione compare con zero e zero', async () => {
    h.db.chat_messages = []
    h.db.chat_threads = []
    const b = await corpo(await GET(req()))
    expect(b.data?.find((d) => d.id === D_SENZA)).toMatchObject({ ricevuti30g: 0, nonLetti: 0 })
  })

  it('di un messaggio TRASFERITO si leggono DUE colonne, e `content` NON è fra loro', async () => {
    // Non basta che il testo non compaia nella risposta: non deve nemmeno
    // arrivare al server. Qui si fissano le colonne ESATTE delle letture che
    // portano righe — aggiungerne una («tanto è comodo averla») rende rosso
    // questo test, che è il punto. Le head-query sono un'altra cosa e hanno il
    // test qui sotto: non trasferiscono niente, e `select('id')` è solo il modo
    // di chiedere un `count` a PostgREST.
    await GET(req())
    const trasferite = h.selezioni.filter((x) => x.tabella === 'chat_messages' && !x.head)
    expect(trasferite.length, 'nessuna lettura dei messaggi: il test non prova niente').toBeGreaterThanOrEqual(1)
    for (const x of trasferite) {
      expect(x.colonne.split(',').map((c) => c.trim()).sort()).toEqual(['sender_id', 'thread_id'])
    }
    expect(h.selezioni.filter((x) => x.tabella === 'chat_messages').every((x) => !x.colonne.includes('content'))).toBe(true)
  })

  it('la finestra è di 30 GIORNI: 29 conta, 31 no', async () => {
    // I due messaggi ai bordi sono entrambi già letti, quindi spostano solo i
    // ricevuti. Con una finestra sbagliata di un ordine di grandezza — «30 ore»
    // al posto di «30 giorni», che nel codice è un `86_400_000` diventato
    // `3_600_000` — `m6` uscirebbe dal conteggio e questo test è l'unico che se
    // ne accorge.
    const b = await corpo(await GET(req()))
    expect(b.data?.find((d) => d.id === D_SENZA)?.ricevuti30g).toBe(4)

    // La controprova: spostando `m6` a 31 giorni scende a tre.
    h.db.chat_messages = (h.db.chat_messages as Record<string, unknown>[]).map((m) =>
      m.id === 'm6' ? { ...m, created_at: giorniFa(31) } : m,
    )
    const b2 = await corpo(await GET(req()))
    expect(b2.data?.find((d) => d.id === D_SENZA)?.ricevuti30g).toBe(3)
  })

  it('le conversazioni di chi HA il dispositivo non si leggono affatto', async () => {
    // `.in('teacher_id', …)` restringe la lettura dei thread alle maestre senza
    // dispositivi. Senza quel filtro entrerebbero anche i thread di
    // `D_CON_PUSH`: lei non comparirebbe nell'elenco (non è fra le «senza
    // push»), ma i suoi due messaggi finirebbero nel conteggio di sede scritto
    // nel registro — un numero gonfiato su una lettura che non serviva.
    await GET(req())
    expect(rigaRegistro()).toMatchObject({ n_messaggi: 9 })
    const b = await corpo(await GET(req()))
    expect(b.data?.map((d) => d.id)).not.toContain(D_CON_PUSH)
  })

  it('i NON LETTI si CONTANO: head-query, nessuna riga trasferita', async () => {
    // L'arretrato non ha finestra: trasferire tutte le righe con `read_at` nullo
    // di tutti i thread, dei due versi e da sempre, per poi scartare in JS
    // quelle scritte dalla maestra, è il conteggio più caro possibile del numero
    // più piccolo. Si contano come li conta il badge della chat.
    await GET(req())
    const teste = h.selezioni.filter((x) => x.tabella === 'chat_messages' && x.head)
    expect(teste.length, 'nessuna head-query: i non letti si stanno trasferendo').toBeGreaterThanOrEqual(1)
    for (const x of teste) expect(x.count).toBe('exact')
  })

  it('di una docente non si legge l\'email, né altro fuori da quattro colonne', async () => {
    await GET(req())
    const sel = h.selezioni.filter((x) => x.tabella === 'utenti')
    expect(sel.length).toBeGreaterThanOrEqual(1)
    const ammesse = new Set(['id', 'nome', 'cognome', 'archiviato_il'])
    for (const x of sel) {
      for (const c of x.colonne.split(',').map((y) => y.trim())) {
        expect(ammesse.has(c), `colonna non prevista nella lettura delle docenti: ${c}`).toBe(true)
      }
    }
  })

  it('`limite` e `offset` paginano la risposta, e `totale` resta quello vero', async () => {
    const b1 = await corpo(await GET(req('?limite=1')))
    expect(b1.data?.map((d) => d.id)).toEqual([D_TANTI_NON_LETTI])
    expect(b1.totale).toBe(3)
    const b2 = await corpo(await GET(req('?limite=1&offset=1')))
    expect(b2.data?.map((d) => d.id)).toEqual([D_SENZA])
    expect(b2.totale).toBe(3)
  })

  it('il TESTO dei messaggi non esce dalla route, e non entra nei log', async () => {
    const res = await GET(req())
    expect(JSON.stringify(await res.json())).not.toContain(SEGRETO)
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain(SEGRETO)
  })
})

describe('GET /api/admin/chat/docenti-senza-push — la riga di registro', () => {
  // Questa route non legge nessun `content`, ma attraversa `chat_messages` e ne
  // restituisce una misura col nome della docente accanto. Il lock
  // `vigilanza-chat-tracciata` non distingue fra leggere e contare, e non ha
  // allowlist: si registra, e la registrazione è bloccante.
  it('con UNA sede: una riga, con quella sede e il suo conteggio, senza nomi', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(righeRegistro()).toHaveLength(1)
    const riga = rigaRegistro()
    expect(riga).toMatchObject({
      operatore_id: DIRIGENTE,
      operatore_ruolo: 'coordinator',
      azione: 'lettura',
      esito: 'ok',
      thread_id: null,
      // 4 messaggi di D_SENZA (m1, m2, m3, m6) + 5 di D_TANTI_NON_LETTI, tutti
      // a SEDE_A. NON i due di T_CON_PUSH: quella maestra i dispositivi li ha,
      // e i suoi thread non vengono nemmeno letti.
      n_messaggi: 9,
      scuola_id: SEDE_A,
    })
    expect(JSON.stringify(riga)).not.toContain('Bianchi')
    expect(JSON.stringify(riga)).not.toContain(SEGRETO)
  })

  it('se la riga NON si scrive, i numeri non escono: 503 e nessun elenco', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '23502', message: 'null value' } }
    const res = await GET(req())
    expect(res.status).toBe(503)
    const b = await corpo(res)
    expect(b.codice).toBe('VIGILANZA_NON_TRACCIABILE')
    expect(b.data).toBeUndefined()
  })

  it('sul DB E2E della CI (tabella del registro assente) NON blocca: 200 e elenco servito', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '42P01', message: 'relation does not exist' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await corpo(res)).totale).toBe(3)
  })

  it('con DUE sedi: due righe, ognuna con la SUA sede e il suo conteggio', async () => {
    // Una riga sola con `scuola_id` nullo non comparirebbe MAI nella scheda
    // «Registro», perché chi la legge filtra `.in('scuola_id', scope)`: con tre
    // sedi, a ogni apertura — tracciato secondo il codice, invisibile secondo il
    // lettore.
    h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'admin', scuola_id: SEDE_A } })
    h.db.utenti_scuole = [
      { utente_id: DIRIGENTE, scuola_id: SEDE_A },
      { utente_id: DIRIGENTE, scuola_id: SEDE_B },
    ]
    await GET(req())
    const righe = righeRegistro()
    expect(righe).toHaveLength(2)
    const perSede = new Map(
      righe.map((_, i) => {
        const r = rigaRegistro(i)
        return [r.scuola_id as string, r.n_messaggi as number]
      }),
    )
    expect([...perSede.keys()].sort()).toEqual([SEDE_A, SEDE_B].sort())
    // Ogni riga porta i messaggi DELLA SUA sede, non il totale ripetuto: 9 a
    // SEDE_A, e a SEDE_B il solo messaggio di D_ALTRA_SEDE.
    expect(perSede.get(SEDE_A)).toBe(9)
    expect(perSede.get(SEDE_B)).toBe(1)
    // Nessuna riga senza sede: sarebbe invisibile nella scheda «Registro».
    expect([...perSede.keys()]).not.toContain(null)
  })

  it('una sede con conversazioni LETTE ma solo arretrato vecchio ha comunque la sua riga (a 0)', async () => {
    // La regola è «le sedi delle conversazioni ATTRAVERSATE», non «le sedi con messaggi
    // recenti»: a SEDE_B la route legge `chat_messages` (per i non letti, senza finestra)
    // anche se nei 30 giorni non c'è niente — e un accesso ai messaggi senza traccia è
    // esattamente ciò che il registro esiste per impedire.
    h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'admin', scuola_id: SEDE_A } })
    h.db.utenti_scuole = [
      { utente_id: DIRIGENTE, scuola_id: SEDE_A },
      { utente_id: DIRIGENTE, scuola_id: SEDE_B },
    ]
    h.db.chat_messages = h.db.chat_messages.map((m) => (m.id === 'x1' ? { ...m, created_at: vecchio() } : m))
    await GET(req())
    const perSede = new Map(
      righeRegistro().map((_, i) => {
        const r = rigaRegistro(i)
        return [r.scuola_id as string, r.n_messaggi as number]
      }),
    )
    expect(perSede.get(SEDE_B)).toBe(0)
    expect(perSede.get(SEDE_A)).toBe(9)
  })

  it('un solo 503 se QUALUNQUE riga di registro non si scrive, anche con due sedi', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'admin', scuola_id: SEDE_A } })
    h.db.utenti_scuole = [
      { utente_id: DIRIGENTE, scuola_id: SEDE_A },
      { utente_id: DIRIGENTE, scuola_id: SEDE_B },
    ]
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '23502', message: 'null value' } }
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect((await corpo(res)).codice).toBe('VIGILANZA_NON_TRACCIABILE')
  })

  it('se il PRIMO insert fallisce, gli altri si scrivono comunque (e poi 503)', async () => {
    // Fermarsi alla prima riga mancata rinuncerebbe alle tracce delle altre
    // sedi, che sono proprio quelle che si vogliono avere quando qualcosa va
    // storto. Il 503 resta uno.
    h.requireStaff.mockResolvedValue({ user: { id: DIRIGENTE, role: 'admin', scuola_id: SEDE_A } })
    h.db.utenti_scuole = [
      { utente_id: DIRIGENTE, scuola_id: SEDE_A },
      { utente_id: DIRIGENTE, scuola_id: SEDE_B },
    ]
    h.erroreSoloPrimoInsert = { code: '23502', message: 'null value' }
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect((await corpo(res)).codice).toBe('VIGILANZA_NON_TRACCIABILE')
    // La prima è caduta, la seconda è nel registro.
    expect(righeRegistro()).toHaveLength(1)
  })

  it('nessuna conversazione letta: nessuna riga di registro, e 200', async () => {
    // Le righe si scrivono sulle sedi dei thread DAVVERO letti: se non se n'è
    // letto nessuno non c'è niente da tracciare, e nessun 503.
    h.db.chat_threads = []
    h.db.chat_messages = []
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(righeRegistro()).toHaveLength(0)
    expect((await corpo(res)).totale).toBe(3)
  })

  it('il gate nega: nessuna riga di registro e nessuna tabella letta', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    await GET(req())
    expect(righeRegistro()).toHaveLength(0)
    // Il titolo promette anche questo, e una promessa non asserita è un
    // commento: dopo un diniego non si deve toccare nessuna tabella.
    expect(h.tabelle).toEqual([])
  })
})

describe('GET /api/admin/chat/docenti-senza-push — errori e log', () => {
  it('lettura delle docenti fallita: 500 col codice dichiarato, e una riga di errore', async () => {
    h.errori = { 'utenti:select': { code: '08006', message: 'connection failure' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/chat/docenti-senza-push:GET', stato: 500 }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  // ⚠️ LE TRE LETTURE QUI SOTTO ASSERISCONO **QUALE** ERRORE FINISCE NEL LOG, non
  // solo che una riga c'è. Provato: ingoiando il `{ error }` dei dispositivi la
  // route risponde 500 lo stesso — perché due righe più sotto itera su `null` e
  // l'eccezione arriva al `catch` esterno — e un test che si fermasse allo status
  // resterebbe verde su un controllo cancellato, registrando un `TypeError` al
  // posto del guasto PostgREST che dice cosa è andato storto.
  it('lettura dei dispositivi fallita: 500, e nel log il guasto VERO del database', async () => {
    h.errori = { 'push_subscriptions:select': { code: '08006', message: 'connection failure' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/chat/docenti-senza-push:GET', evento: 'db' }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('lettura delle conversazioni fallita: 500, non un conteggio a zero', async () => {
    h.errori = { 'chat_threads:select': { code: '08006', message: 'connection failure' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'db' }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('lettura dei messaggi fallita: 500, non «nessun messaggio in attesa»', async () => {
    h.errori = { 'chat_messages:select': { code: '08006', message: 'connection failure' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'db' }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('guasto sulla SOLA lettura dei non letti: 500, non un arretrato a zero', async () => {
    // Le due letture dei messaggi sono la stessa tabella e la stessa
    // operazione: senza iniettare sulla firma della seconda
    // (`.is('read_at', null)`), il suo ramo d'errore non lo esercita nessuno —
    // e ignorarlo darebbe «nessun arretrato» a chi ne ha trenta.
    h.erroreSoloNonLetti = { code: '08006', message: 'connection failure' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'db' }),
      expect.objectContaining({ code: '08006' }),
    )
  })

  it('perimetro VUOTO: elenco vuoto e NESSUNA lettura di dati', async () => {
    // Cookie `sedi_attive` che nomina una sede non accessibile: `resolveScuoleAttive`
    // restituisce `[]`, cioè NEGA. Con lo scope vuoto un `.in('scuola_id', [])`
    // tornerebbe comunque zero righe, quindi la risposta si somiglia — ma le
    // query partirebbero. Qui si fissa che non parta niente: è la differenza fra
    // «non hai sedi» e «leggo tutto e poi filtro».
    const conCookie = new NextRequest('http://localhost/api/admin/chat/docenti-senza-push', {
      headers: { cookie: `sedi_attive=${SEDE_C}` },
    })
    const res = await GET(conCookie)
    expect(res.status).toBe(200)
    const b = await corpo(res)
    expect(b.data).toEqual([])
    expect(b.totale).toBe(0)
    expect(h.tabelle).not.toContain('utenti')
    expect(h.tabelle).not.toContain('chat_messages')
    expect(righeRegistro()).toHaveLength(0)
  })

  it('il SUCCESSO logga i numeri: quante senza push, su quante, e quanti messaggi', async () => {
    await GET(req())
    expect(h.logEvento).toHaveBeenCalledWith(
      'chat',
      'info',
      expect.objectContaining({
        operazione: 'admin/chat/docenti-senza-push:GET',
        esito: 'ok',
        senza_push: 3,
        docenti: 4,
        messaggi: 9,
        non_letti: 8,
        giorni: 30,
      }),
    )
  })

  it('il log di successo non porta NIENT\'ALTRO: solo numeri, esito e operazione', async () => {
    // `objectContaining` non basta a provarlo: un campo in più — «la prima
    // dell'elenco», che verrebbe naturale aggiungere per capire chi è — lo
    // lascerebbe passare. `redact` è a lista bianca e un nome lo hasherebbe, ma
    // un hash correlabile del cognome di una maestra in `app_log` resta un dato
    // che nessuno ha chiesto. Qui si fissa l'insieme ESATTO delle chiavi.
    await GET(req())
    const successo = h.logEvento.mock.calls.find(
      (c) => c[1] === 'info' && (c[2] as { esito?: string })?.esito === 'ok',
    )
    expect(successo, 'il log di successo non è stato emesso').toBeTruthy()
    expect(Object.keys(successo![2] as object).sort()).toEqual(
      ['docenti', 'esito', 'giorni', 'messaggi', 'non_letti', 'operazione', 'sedi', 'senza_push'].sort(),
    )
  })

  it('`archiviato_il` assente (DB E2E non migrato): l\'elenco esce comunque, con un avviso', async () => {
    // PostgREST su una colonna che non c'è non omette il campo: fallisce la
    // SELECT INTERA con `42703`. Senza il ripiego, questa route risponderebbe
    // 500 su ogni ambiente non migrato.
    const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
    const server = await import('@/lib/supabase/server-client')
    const vero = creaFintoSupabase(h.db, h.tabelle, { errori: h.errori })
    let primaVolta = true
    // `mockResolvedValueOnce`: `vi.clearAllMocks()` azzera le CHIAMATE, non
    // l'implementazione di uno spy, e un client finto rimasto attaccato
    // silenziosamente ai test successivi è il modo in cui un file di test
    // comincia a misurare sé stesso.
    const spia = vi.spyOn(server, 'createAdminClient').mockResolvedValueOnce(
      new Proxy(vero, {
        get(t, p, r) {
          if (p !== 'from') return Reflect.get(t, p, r)
          return (tabella: string) => {
            if (tabella === 'utenti' && primaVolta) {
              primaVolta = false
              h.tabelle.push(tabella)
              // ⚠️ Il finto client NON proietta le colonne: restituisce la riga
              // intera qualunque cosa chieda la `select`. Qui si simula la
              // proiezione vera di PostgREST — la lettura di ripiego non chiede
              // `archiviato_il`, quindi quel campo non arriva — altrimenti il
              // test non potrebbe mostrare la proprietà che conta: senza la
              // colonna nessuno risulta archiviato.
              h.db.utenti = (h.db.utenti as Record<string, unknown>[]).map((u) => {
                const copia = { ...u }
                delete copia.archiviato_il
                return copia
              })
              const rotto: Record<string, unknown> = {}
              const passa = () => rotto
              for (const m of ['select', 'eq', 'in', 'is', 'neq', 'order', 'range', 'gte']) rotto[m] = passa
              rotto.then = (ok: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { code: '42703', message: 'column utenti.archiviato_il does not exist' } }).then(ok)
              return rotto
            }
            return (t as unknown as { from: (s: string) => unknown }).from(tabella)
          }
        },
      }) as never,
    )
    const res = await GET(req())
    spia.mockRestore()
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // Senza la colonna nessuno è archiviato: `D_ARCHIVIATA` rientra, e va detto.
    expect(b.data?.map((d) => d.id)).toContain(D_ARCHIVIATA)
    expect(b.data?.map((d) => d.id)).toContain(D_SENZA)
    expect(h.logEvento).toHaveBeenCalledWith(
      'chat',
      'warn',
      expect.objectContaining({ operazione: 'admin/chat/docenti-senza-push:GET' }),
      expect.objectContaining({ code: '42703' }),
    )
  })
})
