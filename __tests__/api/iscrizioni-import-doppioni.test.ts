import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * IMPORT A MANO — IL BAMBINO GEMELLO, IL GENITORE GEMELLO, IL CODICE CHE NON TORNA.
 *
 * ─── IL GUASTO, MISURATO IL 2026-09-14 ──────────────────────────────────────
 * Sette coppie di alunni doppi nella stessa sede: stesso nome, cognome e data di
 * nascita, codici fiscali diversi per un carattere, uno dei due col carattere di
 * controllo sbagliato. L'import riconosceva un bambino SOLO per codice fiscale
 * identico: il refuso ha fatto nascere un secondo alunno (e a volte un secondo
 * genitore), due rette, i solleciti sulla retta fantasma, un bonifico riconciliato
 * sulla copia sbagliata.
 *
 * ─── COSA BLOCCA QUESTO FILE ────────────────────────────────────────────────
 *  1. gemello in sede ⇒ errore BLOCCANTE `POSSIBILE_DOPPIONE`, e NESSUNA scrittura;
 *  2. `abbinamenti` verso quel gemello ⇒ si riusa la scheda, nessun alunno nuovo;
 *  3. `abbinamenti` verso una scheda che non è un gemello, o fuori scope ⇒ rifiuto,
 *     nessuna scrittura: l'id arriva dal client e non vale niente da solo;
 *  4. genitore gemello UNICO ⇒ si riusa la scheda, con un avviso; l'accesso resta
 *     quello della SCHEDA, non l'email della domanda;
 *  5. codice fiscale che non supera il carattere di controllo ⇒ avviso, non blocco.
 *
 * Il finto client APPLICA i filtri e REGISTRA le scritture: «nessuna scrittura» qui
 * è una proprietà misurata sul database finto, non un conteggio di chiamate.
 *
 * ⚠️ DATI DI PROVA: nomi convenzionali e codici fiscali col catastale `Z999`, che non
 * è assegnato a nessuno stato (convenzione di `__tests__/lib/fiscale/`).
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  ensureParentIdentity: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
}))
vi.mock('@/lib/email/contesto', () => ({ risolviContestoSede: async () => ({ email: null, nome: 'Sede di prova' }) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: h.ensureParentIdentity }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE],
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
  scuoleDiUtente: async () => [SEDE],
  assertAlunnoInScope: h.assertAlunnoInScope,
}))
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...m,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, [], { scritture: h.scritture as Scrittura[] }),
}))

import { PATCH } from '@/app/api/admin/iscrizioni/route'

const SEDE = 'a1a1a1a1-0000-4000-8000-000000000001'
const ALTRA_SEDE = 'b2b2b2b2-0000-4000-8000-000000000002'
const DOMANDA = 'f0f0f0f0-0000-4000-8000-000000000010'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const ALTRO_ALUNNO = 'c3c3c3c3-0000-4000-8000-000000000099'
const GENITORE = 'd4d4d4d4-0000-4000-8000-000000000005'
const ACCOUNT = 'e5e5e5e5-0000-4000-8000-000000000006'

/** Valido (verificato in `validazione.test.ts`). */
const CF_VALIDO = 'XQQYKV19C07Z999T'
/** Lo stesso codice col carattere di controllo sbagliato: il refuso misurato. */
const CF_REFUSO = 'XQQYKV19C07Z999A'
const NATO_IL = '2019-03-07'
/** Codice d'adulto fittizio e VALIDO (donna, 10 giugno 1985, catastale Z999)… */
const CF_ADULTO = 'XQQYKV85H50Z999J'
/** …e lo stesso con il carattere di controllo sbagliato. */
const CF_ADULTO_ALTRO = 'XQQYKV85H50Z999K'

const MESSAGGIO_DOPPIONE =
  'In questa sede esiste già un bambino con lo stesso nome e la stessa data di nascita, ma con un codice fiscale diverso. Se la famiglia ha inviato la domanda due volte, rifiuta questa. Se è lo stesso bambino, usa la scheda esistente.'

const bambino = (over: Record<string, unknown> = {}) => ({
  nome: 'Mario',
  cognome: 'Rossi',
  data_nascita: NATO_IL,
  codice_fiscale: CF_REFUSO,
  ...over,
})

const adulto = (over: Record<string, unknown> = {}) => ({
  first_name: 'Anna',
  last_name: 'Bianchi',
  birth_date: '1985-06-10',
  fiscal_code: CF_ADULTO,
  email: 'anna@example.test',
  ruolo: 'mother',
  ...over,
})

const schedaAlunno = (over: Record<string, unknown> = {}) => ({
  id: ESISTENTE,
  scuola_id: SEDE,
  nome: 'Mario',
  cognome: 'Rossi',
  data_nascita: NATO_IL,
  codice_fiscale: CF_VALIDO,
  anonimizzato_il: null,
  ...over,
})

const domanda = (children: unknown[], adults: unknown[] = [adulto()]) => ({
  id: DOMANDA,
  scuola_id: SEDE,
  status: 'pending',
  consents_log: null,
  data: { children, adults },
})

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const importa = (extra: Record<string, unknown> = {}) =>
  PATCH(req({
    id: DOMANDA,
    action: 'import',
    assignments: { '0': '3 ANNI' },
    rette: { '0': 300 },
    referenteIndex: 0,
    ...extra,
  }) as never)

const scritture = () => h.scritture as Scrittura[]
const scrittureSu = (tabella: string, operazione?: string) =>
  scritture().filter((s) => s.tabella === tabella && (!operazione || s.operazione === operazione))

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.eventi = []
  h.db = {
    enrollment_submissions: [domanda([bambino()])],
    sections: [{ id: 'sez-1', scuola_id: SEDE, name: '3 ANNI' }],
    alunni: [],
    parents: [],
  }
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.ensureParentIdentity.mockImplementation(async (_s: unknown, p: { emails: string[] }) => ({
    ok: true,
    authUserId: ACCOUNT,
    email: p.emails[0],
    createdAuth: false,
    createdUtenti: false,
    boundNow: false,
    password: null,
  }))
})

describe('import a mano — il bambino gemello ferma l\'import', () => {
  it('gemello in sede e nessun abbinamento → errore bloccante POSSIBILE_DOPPIONE, e NESSUNA scrittura', async () => {
    h.db.alunni = [schedaAlunno()]
    const res = await importa()
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json.success).toBe(false)
    expect(json.errors).toContainEqual({
      dove: 'Bambino 1',
      messaggio: MESSAGGIO_DOPPIONE,
      codice: 'POSSIBILE_DOPPIONE',
      bambino: 0,
      alunno_esistente_id: ESISTENTE,
    })
    // Nessuna scrittura, in NESSUNA tabella: né il bambino, né il genitore, né la
    // domanda. Il blocco sta nel pre-flight, prima degli adulti — bloccare più a
    // valle avrebbe già creato il `parents` e spedito le credenziali.
    expect(scritture()).toEqual([])
    expect(h.ensureParentIdentity).not.toHaveBeenCalled()
  })

  it('il log dice «possibile doppione» con uuid e indice, e senza un solo dato personale', async () => {
    h.db.alunni = [schedaAlunno()]
    await importa()
    const ev = h.eventi.find((e) => e.campi.esito === 'possibile-doppione')
    expect(ev?.evento).toBe('iscrizione')
    expect(ev?.livello).toBe('warn')
    expect(ev?.campi).toMatchObject({ entita: 'bambino', indice: 1, sede_id: SEDE, alunno_esistente_id: ESISTENTE })
    const scritto = JSON.stringify(h.eventi.map((e) => e.campi))
    for (const dato of ['Mario', 'Rossi', CF_VALIDO, CF_REFUSO, NATO_IL, 'anna@example.test']) {
      expect(scritto).not.toContain(dato)
    }
  })

  it('più schede gemelle → bloccante SENZA proporne una: sceglierla sarebbe indovinare', async () => {
    h.db.alunni = [schedaAlunno(), schedaAlunno({ id: ALTRO_ALUNNO, codice_fiscale: null })]
    const json = await (await importa()).json()
    const errore = json.errors.find((e: { codice?: string }) => e.codice === 'POSSIBILE_DOPPIONE')
    expect(errore).toMatchObject({ dove: 'Bambino 1', bambino: 0 })
    expect(errore).not.toHaveProperty('alunno_esistente_id')
    expect(errore.messaggio).toMatch(/2 bambini/)
    expect(scritture()).toEqual([])
  })

  it('nessun gemello → l\'import va avanti come prima e crea l\'alunno', async () => {
    h.db.alunni = [schedaAlunno({ nome: 'Luca' })]
    const json = await (await importa()).json()
    expect(json.success).toBe(true)
    expect(scrittureSu('alunni', 'insert')).toHaveLength(1)
  })

  it('stesso codice fiscale già in UN\'ALTRA sede → resta il blocco «altra sede», senza un secondo errore', async () => {
    h.db.alunni = [
      schedaAlunno({ id: ALTRO_ALUNNO, scuola_id: ALTRA_SEDE, codice_fiscale: CF_REFUSO }),
      schedaAlunno(),
    ]
    const json = await (await importa()).json()
    expect(json.success).toBe(false)
    const perBambino = json.errors.filter((e: { dove: string }) => e.dove === 'Bambino 1')
    expect(perBambino).toHaveLength(1)
    expect(perBambino[0].messaggio).toMatch(/altra sede/)
    expect(scritture()).toEqual([])
  })
})

describe('import a mano — «è lo stesso bambino»: gli abbinamenti', () => {
  it('abbinamento verso il gemello → si riusa QUELLA scheda: nessun alunno nuovo', async () => {
    h.db.alunni = [schedaAlunno()]
    const json = await (await importa({ abbinamenti: { '0': ESISTENTE } })).json()

    expect(json.success).toBe(true)
    expect(scrittureSu('alunni', 'insert')).toHaveLength(0)
    const aggiornate = scrittureSu('alunni', 'update')
    expect(aggiornate).toHaveLength(1)
    expect(aggiornate[0].colpite.map((r) => r.id)).toEqual([ESISTENTE])
    expect(aggiornate[0].valori[0]).toMatchObject({ classe_sezione: '3 ANNI', importo_retta_mensile: 300 })
    // Il genitore della domanda si lega alla scheda esistente, non a una copia.
    expect(scrittureSu('student_parents').map((s) => s.valori[0].student_id)).toEqual([ESISTENTE])
    // L'id arriva dal client: il gate sull'OGGETTO è stato chiesto per quell'id.
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'seg-1' }), ESISTENTE)
    const ev = h.eventi.find((e) => e.campi.esito === 'abbinato-a-scheda-esistente')
    expect(ev?.livello).toBe('info')
    expect(ev?.campi).toMatchObject({ entita: 'bambino', indice: 1, sede_id: SEDE, alunno_esistente_id: ESISTENTE })
  })

  it('abbinamento verso un alunno che NON è un gemello → rifiuto bloccante, nessuna scrittura', async () => {
    // Un alunno vero, della stessa sede, in scope: ma non ha lo stesso nome e la
    // stessa data. Accettarlo vorrebbe dire agganciare la famiglia della domanda al
    // bambino di un'altra famiglia, scegliendolo dal client.
    h.db.alunni = [schedaAlunno(), schedaAlunno({ id: ALTRO_ALUNNO, nome: 'Luca', codice_fiscale: null })]
    const json = await (await importa({ abbinamenti: { '0': ALTRO_ALUNNO } })).json()

    expect(json.success).toBe(false)
    expect(json.errors).toContainEqual(expect.objectContaining({ dove: 'Bambino 1', codice: 'ABBINAMENTO_NON_VALIDO', bambino: 0 }))
    expect(scritture()).toEqual([])
    expect(h.ensureParentIdentity).not.toHaveBeenCalled()
  })

  it('abbinamento verso un gemello FUORI SCOPE (il gate nega) → rifiuto, nessuna scrittura', async () => {
    h.db.alunni = [schedaAlunno()]
    h.assertAlunnoInScope.mockResolvedValue(new Response(JSON.stringify({ error: 'no' }), { status: 403 }))
    const json = await (await importa({ abbinamenti: { '0': ESISTENTE } })).json()
    expect(json.success).toBe(false)
    expect(json.errors).toContainEqual(expect.objectContaining({ codice: 'ABBINAMENTO_NON_VALIDO', bambino: 0 }))
    expect(scritture()).toEqual([])
  })

  it('abbinamento ma il gemello non c\'è più → rifiuto: non si crea in silenzio l\'alunno che la segreteria voleva riusare', async () => {
    h.db.alunni = []
    const json = await (await importa({ abbinamenti: { '0': ESISTENTE } })).json()
    expect(json.success).toBe(false)
    expect(json.errors).toContainEqual(expect.objectContaining({ codice: 'ABBINAMENTO_NON_VALIDO' }))
    expect(scritture()).toEqual([])
  })

  it('abbinamento per un bambino che la domanda non ha → 400 prima di leggere qualunque cosa', async () => {
    const res = await importa({ abbinamenti: { '3': ESISTENTE } })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ABBINAMENTO_NON_VALIDO')
    expect(scritture()).toEqual([])
  })

  it('abbinamento con un valore che non è un uuid → 400 dallo schema', async () => {
    const res = await importa({ abbinamenti: { '0': 'non-un-uuid' } })
    expect(res.status).toBe(400)
    expect(scritture()).toEqual([])
  })
})

describe('import a mano — il genitore gemello', () => {
  const schedaGenitore = (over: Record<string, unknown> = {}) => ({
    id: GENITORE,
    first_name: 'Anna',
    last_name: 'Bianchi',
    birth_date: '1985-06-10',
    fiscal_code: CF_ADULTO_ALTRO,
    auth_user_id: ACCOUNT,
    emails: ['anna@example.test'],
    anonimizzato_il: null,
    ...over,
  })

  beforeEach(() => {
    // Un bambino senza gemelli: qui l'oggetto è l'adulto.
    h.db.enrollment_submissions = [domanda([bambino({ codice_fiscale: CF_VALIDO })])]
  })

  it('UNA scheda gemella → si riusa al posto dell\'INSERT, con un avviso e un log `warn`', async () => {
    h.db.parents = [schedaGenitore()]
    const json = await (await importa()).json()

    expect(json.success).toBe(true)
    expect(scrittureSu('parents', 'insert')).toHaveLength(0)
    expect(h.ensureParentIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: GENITORE, auth_user_id: ACCOUNT }),
      expect.anything(),
    )
    expect(scrittureSu('student_parents').map((s) => s.valori[0].parent_id)).toEqual([GENITORE])
    expect(json.warnings).toContain(
      'Adulto 1: riconosciuto per nome e data di nascita in una scheda esistente con codice fiscale diverso: verificare il codice fiscale.',
    )
    const ev = h.eventi.find((e) => e.campi.esito === 'genitore-abbinato-per-anagrafica')
    expect(ev?.livello).toBe('warn')
    expect(ev?.campi).toMatchObject({ entita: 'genitore', indice: 1, genitore_esistente_id: GENITORE })
    expect(JSON.stringify(ev?.campi)).not.toContain('Anna')
  })

  it('email della domanda diversa da quella della scheda → l\'accesso resta sulla SCHEDA, e lo si dice', async () => {
    // Una corrispondenza per nome e data è meno certa di un codice fiscale identico:
    // non deve poter riscrivere l'indirizzo di accesso di un account esistente con
    // l'email scritta in un modulo pubblico.
    h.db.parents = [schedaGenitore({ emails: ['vera@example.test'] })]
    h.db.enrollment_submissions = [domanda([bambino({ codice_fiscale: CF_VALIDO })], [adulto({ email: 'altra@example.test' })])]
    const json = await (await importa()).json()

    expect(json.success).toBe(true)
    const [, persona] = h.ensureParentIdentity.mock.calls[0] as [unknown, { emails: string[] }]
    expect(persona.emails).toEqual(['vera@example.test'])
    expect(json.credentials?.email).toBe('vera@example.test')
    expect(json.warnings.some((w: string) => /Adulto 1: l.email indicata nella domanda non è fra quelle della scheda esistente/.test(w))).toBe(true)
  })

  it('PIÙ schede gemelle → comportamento di prima (nuova scheda) più un avviso', async () => {
    h.db.parents = [schedaGenitore(), schedaGenitore({ id: 'd4d4d4d4-0000-4000-8000-000000000077', auth_user_id: null })]
    const json = await (await importa()).json()
    expect(json.success).toBe(true)
    expect(scrittureSu('parents', 'insert')).toHaveLength(1)
    expect(json.warnings.some((w: string) => /^Adulto 1: esistono già 2 schede/.test(w))).toBe(true)
    expect(h.eventi.find((e) => e.campi.esito === 'possibile-doppione' && e.campi.entita === 'genitore')?.livello).toBe('warn')
  })

  it('stesso codice fiscale → il riuso di sempre, nessun avviso di gemello', async () => {
    h.db.parents = [schedaGenitore({ fiscal_code: CF_ADULTO })]
    const json = await (await importa()).json()
    expect(scrittureSu('parents', 'insert')).toHaveLength(0)
    expect(json.warnings.some((w: string) => /riconosciuto per nome/.test(w))).toBe(false)
  })
})

describe('import a mano — il codice fiscale che non supera il carattere di controllo', () => {
  it('bambino con codice sbagliato e nessun gemello → avviso NON bloccante', async () => {
    const json = await (await importa()).json()
    expect(json.success).toBe(true)
    expect(json.warnings).toContain(
      'Bambino 1: il codice fiscale di Mario Rossi non supera il carattere di controllo: correggerlo nella scheda dopo l\'import.',
    )
  })

  it('adulto con codice sbagliato → avviso', async () => {
    h.db.enrollment_submissions = [domanda([bambino({ codice_fiscale: CF_VALIDO })], [adulto({ fiscal_code: 'XQQYKV19C07Z999B' })])]
    const json = await (await importa()).json()
    expect(json.success).toBe(true)
    expect(json.warnings).toContain(
      'Adulto 1: il codice fiscale di Anna Bianchi non supera il carattere di controllo: correggerlo nella scheda dopo l\'import.',
    )
  })

  it('codici validi, o vuoti → nessun avviso sul codice fiscale', async () => {
    h.db.enrollment_submissions = [domanda([bambino({ codice_fiscale: CF_VALIDO })], [adulto({ fiscal_code: '' })])]
    const json = await (await importa()).json()
    expect(json.warnings.filter((w: string) => /codice fiscale/.test(w))).toEqual([])
  })

  it('l\'avviso arriva ANCHE insieme al blocco del doppione: è ciò che dice quale delle due domande ha il refuso', async () => {
    h.db.alunni = [schedaAlunno()]
    const json = await (await importa()).json()
    expect(json.success).toBe(false)
    expect(json.warnings.some((w: string) => /^Bambino 1: il codice fiscale di Mario Rossi non supera/.test(w))).toBe(true)
  })

  it('se il codice sbagliato è quello della SCHEDA esistente, l\'avviso lo dice', async () => {
    h.db.alunni = [schedaAlunno({ codice_fiscale: CF_REFUSO })]
    h.db.enrollment_submissions = [domanda([bambino({ codice_fiscale: CF_VALIDO })])]
    const bloccato = await (await importa()).json()
    expect(bloccato.warnings).toContain(
      'Bambino 1: il codice fiscale della scheda esistente non è valido: correggerlo nella scheda.',
    )

    // …e dopo l'abbinamento l'avviso riguarda la scheda che si è riusata, non il
    // codice della domanda (che è giusto, e non viene scritto da nessuna parte).
    h.scritture = []
    const abbinato = await (await importa({ abbinamenti: { '0': ESISTENTE } })).json()
    expect(abbinato.success).toBe(true)
    expect(abbinato.warnings).toContain(
      'Bambino 1: il codice fiscale della scheda esistente non è valido: correggerlo nella scheda.',
    )
  })

  it('bambino abbinato con il codice della DOMANDA sbagliato → nessun avviso su un codice che non si scrive', async () => {
    h.db.alunni = [schedaAlunno()]
    const json = await (await importa({ abbinamenti: { '0': ESISTENTE } })).json()
    expect(json.success).toBe(true)
    expect(json.warnings.filter((w: string) => /^Bambino 1: .*codice fiscale/.test(w))).toEqual([])
  })
})
