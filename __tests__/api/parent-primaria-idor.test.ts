import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `GET /api/parent/primaria` — L'ULTIMA DELLE OTTO ROUTE DELLA PRIMARIA
// RIMASTA SENZA GATE PER CHI NON AGISCE DA GENITORE.
//
// ─── LA FORMA DEL DIFETTO ────────────────────────────────────────────────────
//
// L'handler diceva:
//
//     if (agisceComeGenitore(auth.user)) { …serve il legame col bambino… }
//     // per tutti gli altri: NIENTE
//
// cioè, letta ad alta voce: «se stai guardando l'app in veste di famiglia e quel
// bambino non è tuo figlio, ti nego». Per chiunque NON stesse agendo da genitore
// — un educator di un'altra sezione o di un'altra sede, la cuoca, la segreteria
// di un altro plesso — il controllo non era permissivo: NON C'ERA. Il gate a
// monte è `requireUser`, che ammette OGNI utente autenticato, e il client è
// `createAdminClient()` (service-role), che scavalca la RLS.
//
// È la stessa identica forma dei due IDOR chiusi lo stesso giorno in
// `parent/submissions:POST` e `parent/forms/otp:PATCH`. Le SETTE route sorelle
// (`primaria/{assenze,note,orario,pagella,scrutinio,valutazioni}` e
// `pagella/firma`) erano già passate a `requireParentOfStudent`: questa era
// l'unica rimasta indietro, e serve gli stessi dati delle altre sette.
//
// ─── COSA USCIVA DA QUELLA PORTA ─────────────────────────────────────────────
//
// Non un elenco di nomi: il REGISTRO di un minore indicato per uuid — lezioni,
// argomenti individualizzati del sostegno, VALUTAZIONI, NOTE DISCIPLINARI in
// testo libero, e le assenze con lo stato della giustificazione. Sono i dati che
// il resto della primaria protegge da un mese.
//
// ─── COME L'HA VISTO FALLIRE ─────────────────────────────────────────────────
//
// Questo file asserisce lo STATO della risposta e le TABELLE toccate, mai «una
// funzione è stata chiamata». Prima del rimedio, un educator della sede A che
// chiedeva un bambino della sede B otteneva `200` con il registro completo, e
// `note_disciplinari` e `valutazioni` risultavano LETTE. Il file è nato rosso su
// quelle asserzioni, ed è la ragione per cui esiste.
//
// ─── PERCHÉ IL FINTO CLIENT E NON UN MOCK PIATTO ─────────────────────────────
//
// `assertAlunnoInScope` NON è mockato: gira sul finto client che i filtri li
// applica davvero. Così «l'educator della propria sezione continua a passare» è
// una proprietà VERIFICATA — e non un'asserzione su un mock che dice sempre di
// sì. Sono 61 educator: se il rimedio gliela togliesse, questo file lo direbbe.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

/** Il figlio: sede A, sezione `sec-a` (quella assegnata a `ed-a`). */
const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
/** Stessa sede dell'educator, ALTRA sezione: non è suo alunno e non è suo figlio. */
const ALU_ALTRA_SEZIONE = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
/** Un minore di un ALTRO plesso: per chi chiede, un uuid e nient'altro. */
const ALU_ALTRA_SEDE = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ALU_INESISTENTE = 'cccccccc-3333-4333-8333-cccccccccccc'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  /** `true` = il richiedente ha il legame di famiglia col bambino chiesto. */
  legame: false,
  /** Quante volte il legame è stato interrogato: `0` significa «non chiesto». */
  legameChiesto: 0,
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))

// I DUE nomi con cui si chiede «è tuo figlio?»: `genitoreHasFiglio` è quello che
// l'handler usava da solo, `verificaLegameGenitore` (esito a tre valori) è quello
// del gate. Il mock li tiene sulla STESSA verità, così un verde non può venire
// dal fatto che il rimedio ha cambiato funzione.
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn().mockImplementation(async () => {
    h.legameChiesto++
    return h.legame
  }),
  verificaLegameGenitore: vi.fn().mockImplementation(async () => {
    h.legameChiesto++
    return h.legame ? 'si' : 'no'
  }),
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

import { GET } from '@/app/api/parent/primaria/route'

const req = (studentId: string) =>
  new NextRequest(`http://localhost/api/parent/primaria?studentId=${studentId}`)

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, school_type: 'primaria' },
    { id: 'sec-a2', scuola_id: SEDE_A, school_type: 'primaria' },
    { id: 'sec-b', scuola_id: SEDE_B, school_type: 'primaria' },
  ],
  // Solo `ed-a` ha una sezione assegnata: la cuoca non ne ha, ed è il motivo per
  // cui viene negata anche dentro il PROPRIO plesso.
  utenti_sezioni: [{ utente_id: 'ed-a', section_id: 'sec-a' }],
  utenti_scuole: [],
  alunni: [
    { id: ALU_MIO, nome: 'Alfa', cognome: 'Beta', section_id: 'sec-a', scuola_id: SEDE_A },
    { id: ALU_ALTRA_SEZIONE, nome: 'Gamma', cognome: 'Delta', section_id: 'sec-a2', scuola_id: SEDE_A },
    { id: ALU_ALTRA_SEDE, nome: 'Epsilon', cognome: 'Zeta', section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  admin_settings: [],
  registro_orario: [],
  materie: [],
  presenze: [],
  valutazioni: [
    { id: 'v-1', alunno_id: ALU_MIO, materia: 'Italiano', tipo: 'scritto', modalita: 'voto', creato_il: '2020-01-01T00:00:00.000Z' },
    { id: 'v-2', alunno_id: ALU_ALTRA_SEDE, materia: 'Italiano', tipo: 'scritto', modalita: 'voto', creato_il: '2020-01-01T00:00:00.000Z' },
  ],
  note_disciplinari: [
    { id: 'n-1', alunno_id: ALU_MIO, categoria: 'comportamento', testo: 'nota del proprio figlio', creato_il: '2020-01-01T00:00:00.000Z' },
    { id: 'n-2', alunno_id: ALU_ALTRA_SEDE, categoria: 'comportamento', testo: 'nota di un minore di un altro plesso', creato_il: '2020-01-01T00:00:00.000Z' },
  ],
})

/** L'identità che `requireUser` restituisce. `ruoli` è l'unione dal DATABASE. */
const comeUtente = (
  id: string,
  role: string,
  scuola_id: string | null,
  ruoli?: readonly string[],
) => h.requireUser.mockResolvedValue({ user: { id, role, scuola_id, ...(ruoli ? { ruoli } : {}) } })

/** I `logEvento('auth','warn',{tipo})` emessi nel caso corrente. */
const warnAuth = (): string[] =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === 'auth' && c[1] === 'warn')
    .map((c) => (c[2] as { tipo?: string })?.tipo ?? '')

/** Gli `info` di `auth`, dove finisce il segnale del legame che apre la porta. */
const infoAuth = (): string[] =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === 'auth' && c[1] === 'info')
    .map((c) => (c[2] as { tipo?: string })?.tipo ?? '')

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.legame = false
  h.legameChiesto = 0
})

describe('IDOR: chi non agisce da genitore non incontrava NESSUN controllo', () => {
  it('educator della sede A → 403 su un bambino di un\'ALTRA SEZIONE della sua stessa sede', async () => {
    comeUtente('ed-a', 'educator', SEDE_A)
    const res = await GET(req(ALU_ALTRA_SEZIONE))
    expect(res.status).toBe(403)
    // Il danno non è il 200: è ciò che il 200 portava con sé.
    expect(h.tabelle, 'le note disciplinari non devono essere nemmeno lette').not.toContain('note_disciplinari')
    expect(h.tabelle, 'le valutazioni non devono essere nemmeno lette').not.toContain('valutazioni')
  })

  it('educator della sede A → 403 su un minore di un ALTRO PLESSO, con warn `alunno-fuori-sede`', async () => {
    comeUtente('ed-a', 'educator', SEDE_A)
    const res = await GET(req(ALU_ALTRA_SEDE))
    expect(res.status).toBe(403)
    // Senza il log non esiste nemmeno il segnale che qualcuno ci ha provato.
    expect(warnAuth()).toContain('alunno-fuori-sede')
  })

  it('cuoca → 403 anche nella PROPRIA sede: nessuna sezione assegnata', async () => {
    // Non è un attore di fantasia: è uno dei sette profili con cui, il 31/07, la
    // stessa lettura è stata misurata a 200 in produzione sulle route sorelle.
    comeUtente('cuoca-1', 'cuoca', SEDE_A)
    const res = await GET(req(ALU_MIO))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('note_disciplinari')
  })

  it('il registro di un minore non esce nel corpo di nessuna di quelle risposte', async () => {
    comeUtente('ed-a', 'educator', SEDE_A)
    const corpo = await (await GET(req(ALU_ALTRA_SEDE))).json()
    expect(JSON.stringify(corpo)).not.toContain('nota di un minore di un altro plesso')
    expect(corpo.data, 'un 403 non porta dati').toBeUndefined()
  })
})

describe('il perimetro legittimo NON si stringe', () => {
  it('il genitore col legame apre il registro del proprio figlio (200, dati compresi)', async () => {
    comeUtente('gen-1', 'genitore', null)
    h.legame = true
    const res = await GET(req(ALU_MIO))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.schoolType).toBe('primaria')
    expect(corpo.data.note.map((n: { id: string }) => n.id)).toEqual(['n-1'])
    expect(h.legameChiesto, 'il legame dev’essere stato chiesto: è il presidio').toBe(1)
  })

  it('il genitore SENZA legame → 403 e warn `alunno-non-della-famiglia` (invariato)', async () => {
    comeUtente('gen-1', 'genitore', null)
    h.legame = false
    const res = await GET(req(ALU_ALTRA_SEDE))
    expect(res.status).toBe(403)
    expect(warnAuth()).toContain('alunno-non-della-famiglia')
  })

  it('la docente-genitore col legame, IN VESTE DI LAVORO, apre il registro del proprio figlio', async () => {
    // Sono cinque persone reali in produzione: `utenti.ruolo = 'educator'` PIÙ il
    // ponte `parents.auth_user_id`. Il figlio sta in un'altra sede e fuori dalle
    // sezioni che insegnano: sullo scope di lavoro cadrebbero, sul LEGAME no.
    // La biforcazione è sul legame, non sulla veste.
    comeUtente('doc-gen', 'educator', SEDE_A, ['educator', 'genitore'])
    h.legame = true
    const res = await GET(req(ALU_ALTRA_SEDE))
    expect(res.status).toBe(200)
    // Il segnale che dice se la correzione è VIVA: la porta si è aperta per il
    // legame, non perché non ci fosse nessuna porta.
    expect(infoAuth(), 'il 200 dev’essere motivato dal legame').toContain('accesso-per-legame-famiglia')
  })

  it('CONTROLLO POSITIVO: l\'educator apre il registro di un bambino della PROPRIA sezione', async () => {
    // 61 educator: se il rimedio gli togliesse questa lettura, sarebbe una
    // funzione tolta di nascosto, non una vulnerabilità chiusa.
    comeUtente('ed-a', 'educator', SEDE_A)
    const res = await GET(req(ALU_MIO))
    expect(res.status).toBe(200)
    expect(warnAuth()).not.toContain('alunno-fuori-sede')
    expect(h.legameChiesto, 'a chi non è famiglia il legame non si chiede: sarebbe il mestiere negato').toBe(0)
  })

  it('CONTROLLO POSITIVO: la segreteria vede tutte le CLASSI del proprio plesso', async () => {
    // Il caso che il rimedio poteva rompere in silenzio: la segreteria apre la
    // primaria di un bambino qualunque della propria sede, anche fuori dalle
    // sezioni. `vedeTutteLeClassi` la ammette, e deve continuare a farlo.
    comeUtente('seg-a', 'segreteria', SEDE_A)
    const res = await GET(req(ALU_ALTRA_SEZIONE))
    expect(res.status).toBe(200)
  })
})

describe('«non è tuo» e «non esiste» restano distinti', () => {
  it('studentId non-uuid → 404 con `codice`, PRIMA di qualunque lettura (lezione T16)', async () => {
    // Un id malformato non è un tentativo di leggere il figlio di un altro: è un
    // client che sbaglia. Deve costare 404 — e non un `error` PostgREST `22P02`
    // che alimenta la soglia `tasso-errore` di /api/health. Il `codice` serve
    // perché le schermate della famiglia mostrano SOLO frasi di catalogo.
    comeUtente('gen-1', 'genitore', null)
    h.legame = true
    const res = await GET(req('non-un-uuid'))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ALUNNO_NON_TROVATO')
    expect(h.tabelle, 'la guardia uuid sta PRIMA di ogni query').not.toContain('alunni')
    expect(warnAuth(), 'un refuso non riempie il contatore dei tentativi').toHaveLength(0)
  })

  it('alunno inesistente → 404 e NESSUN warn di sicurezza', async () => {
    comeUtente('seg-a', 'segreteria', SEDE_A)
    const res = await GET(req(ALU_INESISTENTE))
    expect(res.status).toBe(404)
    expect(warnAuth()).not.toContain('alunno-fuori-sede')
  })
})
