import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `requireParentOfStudent` — il gate che protegge 20 route su dati di MINORI.
//
// Fino al 2026-07-31 la verifica del legame si applicava SOLO a chi era
// `genitore`; ogni altro ruolo passava, e la testata del file lo dichiarava
// pure: «staff/educator passano: il loro scope è applicato altrove nelle
// rispettive query». Su quasi tutti i rami quell'altrove NON esisteva, e il
// client è `createAdminClient()` (service-role), che scavalca la RLS: la difesa
// applicativa era l'unica, e non c'era.
//
// Misurato in produzione: un educator di Aversa otteneva 200 e il diario
// completo di un bambino iscritto a Giugliano; la cuoca pure. L'unico 403
// arrivava all'altro genitore.
//
// Qui si mette a contratto la forma corretta:
//   genitore      → `genitoreHasFiglio` (legame di famiglia, invariato)
//   chiunque altro→ `assertAlunnoInScope` (plesso + sezione assegnata)
//
// I test NON mockano `assertAlunnoInScope`: girano sul finto client che i
// filtri li APPLICA davvero, così «l'educator di un'altra sede è fuori scope»
// è una proprietà verificata e non asserita.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'   // sede A, sezione del docente
const ALU_A2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'  // sede A, ALTRA sezione
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'   // sede B
const ALU_INESISTENTE = 'cccccccc-3333-4333-8333-cccccccccccc'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: h.genitoreHasFiglio,
  // Esito a tre valori del gate: qui si deriva dal mock booleano storico.
  verificaLegameGenitore: async (...a: unknown[]) => ((await h.genitoreHasFiglio(...a)) ? 'si' : 'no'),
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { requireParentOfStudent } from '@/lib/auth/require-parent'

const req = () => new Request('http://localhost/api/parent/x')

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: 'SEZIONE UNO' },
    { id: 'sec-a2', scuola_id: SEDE_A, name: 'SEZIONE DUE' },
    { id: 'sec-b', scuola_id: SEDE_B, name: 'SEZIONE UNO' },
  ],
  // Solo `ed-a` ha una sezione assegnata: la cuoca non ne ha, ed è il motivo
  // per cui viene negata anche dentro il proprio plesso.
  utenti_sezioni: [{ utente_id: 'ed-a', section_id: 'sec-a' }],
  utenti_scuole: [
    { utente_id: 'dir-multi', scuola_id: SEDE_A },
    { utente_id: 'dir-multi', scuola_id: SEDE_B },
  ],
  alunni: [
    { id: ALU_A, section_id: 'sec-a', scuola_id: SEDE_A },
    { id: ALU_A2, section_id: 'sec-a2', scuola_id: SEDE_A },
    { id: ALU_B, section_id: 'sec-b', scuola_id: SEDE_B },
  ],
})

const comeUtente = (id: string, role: string, scuola_id: string | null) =>
  h.requireUser.mockResolvedValue({ user: { id, role, scuola_id } })

/** I `logEvento('auth','warn',{tipo})` emessi nel caso corrente. */
const warnAuth = (): string[] =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === 'auth' && c[1] === 'warn')
    .map((c) => (c[2] as { tipo?: string })?.tipo ?? '')

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.genitoreHasFiglio.mockResolvedValue(false)
})

describe('requireParentOfStudent — identità', () => {
  it('anonimo: 401 e non legge nemmeno gli alunni', async () => {
    h.requireUser.mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Non autenticato' }), { status: 401 }),
    })
    const r = await requireParentOfStudent(req(), ALU_B)
    expect(r.response?.status).toBe(401)
    expect(h.tabelle).not.toContain('alunni')
  })
})

describe('requireParentOfStudent — genitore (comportamento invariato)', () => {
  it('legame assente: 403', async () => {
    comeUtente('gen-1', 'genitore', null)
    h.genitoreHasFiglio.mockResolvedValue(false)
    const r = await requireParentOfStudent(req(), ALU_B)
    expect(r.response?.status).toBe(403)
    expect(h.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), 'gen-1', ALU_B)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // IL 403 DEL RAMO GENITORE NON LASCIAVA NESSUNA RIGA INTERROGABILE.
  //
  // Il collaudo del 2026-08-07 ha provato dodici volte di fila a scrivere sul
  // registro di un bambino altrui: dodici 403 corretti, e in `app_log` **niente**
  // — `withRoute` classifica i 403 a livello `info`, e `vaPersistito` tiene in
  // tabella solo `warn` ed `error`. È la stessa forma del difetto originale di
  // questo ciclo (un mese di silenzio perfetto), applicata alla difesa della
  // rotta che scrive dati di minori.
  //
  // Il `warn` esisteva già 27 righe più sotto, ma solo per i NON-genitori: il
  // ramo genitore esce prima e non ci arrivava mai. Il tentativo che più di ogni
  // altro si vorrebbe poter contare era l'unico senza un contatore.
  // ───────────────────────────────────────────────────────────────────────────
  it('legame assente: lascia un `warn` `alunno-non-della-famiglia` (persistito)', async () => {
    comeUtente('gen-1', 'genitore', null)
    h.genitoreHasFiglio.mockResolvedValue(false)
    await requireParentOfStudent(req(), ALU_B)
    expect(
      warnAuth(),
      'senza gate non esiste neppure il segnale che qualcuno ci ha provato',
    ).toContain('alunno-non-della-famiglia')
  })

  it('la riga porta SOLO uuid ed enumerati: attore, alunno, ruolo, azione', async () => {
    comeUtente('gen-1', 'genitore', null)
    h.genitoreHasFiglio.mockResolvedValue(false)
    await requireParentOfStudent(req(), ALU_B)
    const riga = h.logEvento.mock.calls.find(
      (c) => c[0] === 'auth' && c[1] === 'warn' && (c[2] as { tipo?: string })?.tipo === 'alunno-non-della-famiglia',
    )
    expect(riga?.[2]).toMatchObject({
      tipo: 'alunno-non-della-famiglia',
      azione: 'requireParentOfStudent',
      utente: 'gen-1',
      ruolo: 'genitore',
      alunno_id: ALU_B,
    })
    // Niente nomi, niente email, niente testo libero: sono dati di minori.
    expect(JSON.stringify(riga?.[2])).not.toMatch(/@|nome|cognome/i)
  })

  it('il legame che C\'È non lascia nessuna riga: un logger loquace acceca', async () => {
    comeUtente('gen-1', 'genitore', null)
    h.genitoreHasFiglio.mockResolvedValue(true)
    await requireParentOfStudent(req(), ALU_B)
    expect(warnAuth()).not.toContain('alunno-non-della-famiglia')
  })

  it('legame presente: passa, e la sede NON c\'entra (fratelli in due plessi)', async () => {
    comeUtente('gen-1', 'genitore', SEDE_A)
    h.genitoreHasFiglio.mockResolvedValue(true)
    const r = await requireParentOfStudent(req(), ALU_B)
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe('gen-1')
    // Al genitore non si applica lo scope di sede: nessuna lettura di `alunni`.
    expect(h.tabelle).not.toContain('alunni')
  })
})

describe('requireParentOfStudent — educator', () => {
  it('educator della sede A: 403 su un alunno della sede B, con warn `alunno-fuori-sede`', async () => {
    comeUtente('ed-a', 'educator', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_B)
    expect(r.response?.status).toBe(403)
    expect(r.user).toBeUndefined()
    // Senza il log non esiste nemmeno il segnale che qualcuno ci ha provato.
    expect(warnAuth()).toContain('alunno-fuori-sede')
  })

  it('educator della sede A: 403 su un alunno della stessa sede ma di un\'ALTRA sezione', async () => {
    comeUtente('ed-a', 'educator', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_A2)
    expect(r.response?.status).toBe(403)
  })

  it('CONTROLLO POSITIVO: educator della sezione assegnata → passa', async () => {
    comeUtente('ed-a', 'educator', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_A)
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe('ed-a')
    expect(warnAuth()).not.toContain('alunno-fuori-sede')
  })
})

describe('requireParentOfStudent — segreteria e direzione', () => {
  it('segreteria della sede A: 403 su un alunno della sede B', async () => {
    comeUtente('seg-a', 'segreteria', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_B)
    expect(r.response?.status).toBe(403)
    expect(warnAuth()).toContain('alunno-fuori-sede')
  })

  it('CONTROLLO POSITIVO: la segreteria vede tutte le CLASSI della propria sede', async () => {
    comeUtente('seg-a', 'segreteria', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_A2)
    expect(r.response).toBeUndefined()
    expect(r.user?.role).toBe('segreteria')
  })

  it('CONTROLLO POSITIVO: la Direzione multi-sede passa su entrambi i plessi', async () => {
    comeUtente('dir-multi', 'admin', SEDE_A)
    expect((await requireParentOfStudent(req(), ALU_A)).response).toBeUndefined()
    expect((await requireParentOfStudent(req(), ALU_B)).response).toBeUndefined()
  })
})

describe('requireParentOfStudent — cuoca', () => {
  it('cuoca: 403 anche nella PROPRIA sede (nessuna sezione assegnata)', async () => {
    comeUtente('cuoca-1', 'cuoca', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_A)
    expect(r.response?.status).toBe(403)
    expect(warnAuth()).toContain('alunno-fuori-sede')
  })
})

describe('requireParentOfStudent — «non è tuo» e «non esiste» restano distinti', () => {
  it('alunno inesistente: 404 e NESSUN warn (il contatore di sicurezza non si riempie di 404 banali)', async () => {
    comeUtente('seg-a', 'segreteria', SEDE_A)
    const r = await requireParentOfStudent(req(), ALU_INESISTENTE)
    expect(r.response?.status).toBe(404)
    expect(warnAuth()).not.toContain('alunno-fuori-sede')
  })

  it('id malformato: 404 pulito, non un 500 con un `error` di guasto DB', async () => {
    // Sette delle venti route validano `studentId` come stringa non vuota, non
    // come uuid: senza questa guardia PostgREST risponderebbe 22P02, la verifica
    // di scope diventerebbe un 500 e il contatore `scope-alunno-non-risolto` —
    // che esiste per segnalare un GUASTO — si riempirebbe di errori di battitura.
    comeUtente('seg-a', 'segreteria', SEDE_A)
    const r = await requireParentOfStudent(req(), 'non-un-uuid')
    expect(r.response?.status).toBe(404)
    expect(h.logEvento.mock.calls.filter((c) => c[1] === 'error')).toHaveLength(0)
  })
})
