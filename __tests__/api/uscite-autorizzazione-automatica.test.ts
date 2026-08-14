import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `POST /api/teacher/uscite` — l'autorizzazione (prestampato n. 10) nasce da sé
// a ogni gita creata.
//
// `docs/prestampati/10-autorizzazione-uscita.md`: «la segreteria crea l'evento
// una volta; l'app produce un'autorizzazione per ciascun bambino della sezione».
// Qui si verificano le tre proprietà su cui quella frase sta in piedi, e nessuna
// delle tre è asserita a vuoto: il finto client FILTRA e SCRIVE davvero, quindi
// «il modulo è nato per le classi giuste» è una misura sulle righe scritte.
//
//  1. alla creazione dell'uscita nasce l'autorizzazione, per le classi COINVOLTE
//     e nella sede DICHIARATA;
//  2. se l'automatismo si guasta, la gita resta creata — un difetto della
//     generazione automatica non può impedire a un'insegnante di programmare
//     l'uscita — e il guasto lascia una riga con dentro il CORPO dell'errore,
//     non il solo codice (è la lezione delle email di credenziali: un `403`
//     senza corpo non dice niente, `403 "the domain is not verified"` dice
//     tutto);
//  3. la stessa gita creata due volte non genera due autorizzazioni gemelle:
//     alla famiglia arriverebbero due moduli identici da firmare per lo stesso
//     bambino.
//
// Più i due presidi che valgono su ogni scrittura di questo repo: la sede si
// dichiara (400 quando è ambigua) e una sezione di un altro plesso non entra.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_EDUCATOR = 'e0000000-0000-4000-8000-00000000ed00'
const SEC_PICCOLI = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_GRANDI = 'aaaa2222-0000-4000-8000-0000000000a2'
const SEC_ALTRA_SEDE = 'bbbb3333-0000-4000-8000-0000000000b3'
const ALUNNO = 'a1111111-0000-4000-8000-0000000000a1'

/**
 * La gita è nel 2099 di proposito: il termine per autorizzare cade con lei, e un
 * test legato al calendario non è un test — è una scadenza (lezione del
 * 2026-08-09, e di nuovo dell'11 agosto sull'agenda). Con una data nel passato
 * questo file continuerebbe a passare, ma proverebbe un modulo già scaduto.
 */
const GIORNO_GITA = '2099-05-12'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  erroriTabella: {} as Record<string, { code: string; message?: string }>,
}))

// Solo le due funzioni di log sono sostituite: il resto del modulo resta REALE,
// perché `withRoute` ne usa altri pezzi e un mock totale collauderebbe
// l'impalcatura invece della route.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (...a: unknown[]) => h.logEvento(...a),
    logErrore: (...a: unknown[]) => h.logErrore(...a),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => 'test',
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.erroriTabella }),
  }
})

import { GET, POST } from '@/app/api/teacher/uscite/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_PICCOLI, scuola_id: SEDE_A, name: 'PICCOLI' },
    { id: SEC_GRANDI, scuola_id: SEDE_A, name: 'GRANDI' },
    { id: SEC_ALTRA_SEDE, scuola_id: SEDE_B, name: 'PICCOLI' },
  ],
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [{ utente_id: ID_EDUCATOR, section_id: SEC_PICCOLI }],
  eventi_agenda: [],
  forms_templates: [],
  forms_submissions: [],
  alunni: [{ id: ALUNNO, scuola_id: SEDE_A, section_id: SEC_PICCOLI }],
  payment_categories: [{ id: 'cat-gita', slug: 'gita', scuola_id: null }],
  pagamenti: [],
})

function richiesta(url: string, body?: Record<string, unknown>, cookie?: string): NextRequest {
  return {
    url,
    method: body ? 'POST' : 'GET',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body ?? {},
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

const postReq = (body: Record<string, unknown>, cookie?: string) =>
  richiesta('http://localhost/api/teacher/uscite', body, cookie)
const getReq = (qs: string, cookie?: string) =>
  richiesta(`http://localhost/api/teacher/uscite?${qs}`, undefined, cookie)

/** La gita minima valida: le sezioni si dichiarano caso per caso. */
const gita = (extra: Record<string, unknown> = {}) => ({
  tipo_attivita: 'gita',
  destinazione: 'Fattoria didattica',
  data: GIORNO_GITA,
  ora_partenza: '08:30',
  ora_rientro: '16:00',
  mezzo: 'pullman_privato',
  sezioni: [SEC_PICCOLI],
  scuola_id: SEDE_A,
  ...extra,
})

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)
const rigaLog = (esito: string) =>
  h.logEvento.mock.calls.find((c: unknown[]) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroriTabella = {}
  h.requireDocente.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireUser.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('POST /api/teacher/uscite — l’autorizzazione nasce con la gita', () => {
  it('crea l’uscita e, con essa, il modulo per le classi coinvolte', async () => {
    const res = await POST(postReq(gita({ sezioni: [SEC_PICCOLI, SEC_GRANDI] })))

    expect(res.status).toBe(201)

    // La gita: una riga per sezione, tutte nella sede dichiarata.
    const uscite = scrittureSu('eventi_agenda')
    expect(uscite).toHaveLength(1)
    expect(uscite[0].valori).toHaveLength(2)
    expect(uscite[0].valori[0]).toMatchObject({
      scuola_id: SEDE_A,
      section_id: SEC_PICCOLI,
      tipo: 'uscita',
      data: GIORNO_GITA,
      orario_inizio: '08:30',
      orario_fine: '16:00',
      visibile_genitori: true,
      creato_da: ID_ADMIN,
    })

    // L'autorizzazione: UNA per la gita, con dentro le due classi.
    const moduli = scrittureSu('forms_templates')
    expect(moduli).toHaveLength(1)
    const modulo = moduli[0].valori[0] as Record<string, unknown>
    expect(modulo).toMatchObject({
      scuola_id: SEDE_A,
      form_type: 'autorizzazione',
      target_scope: 'class',
    })
    // Le classi sono i NOMI: è con quelli che `parent/forms:GET` abbina il
    // modulo ai figli. Un id di sezione qui vorrebbe dire un modulo che non
    // compare a nessuna famiglia.
    expect([...(modulo.target_classes as string[])].sort()).toEqual(['GRANDI', 'PICCOLI'])
    // Il termine cade a fine giornata: con la sola data il modulo scadrebbe
    // all'alba del giorno in cui si può ancora firmare.
    expect(modulo.expiration_date).toBe(`${GIORNO_GITA}T23:59:59`)

    // I dati della gita sono PRECOMPILATI nel modulo, non richiesti alla famiglia.
    const descrizione = String(modulo.description)
    expect(descrizione).toContain('Fattoria didattica')
    expect(descrizione).toContain('12/05/2099')
    expect(descrizione).toContain('08:30')
    expect(descrizione).toContain('Pullman privato')

    const corpo = await res.json()
    expect(corpo.data.esitoAutorizzazione).toBe('creata')
    expect(corpo.data.autorizzazione.id).toBeTruthy()
    expect(rigaLog('autorizzazione-uscita-creata')?.[1]).toBe('info')
  })

  it('la quota e gli accompagnatori entrano nel modulo; ciò che manca non lascia una riga vuota', async () => {
    await POST(postReq(gita({ quota: 12, accompagnatori: 'due insegnanti di sezione' })))
    const conDati = String(
      (scrittureSu('forms_templates')[0].valori[0] as Record<string, unknown>).description,
    )
    expect(conDati).toContain('€ 12,00')
    expect(conDati).toContain('due insegnanti di sezione')

    h.db = dbBase()
    h.scritture = []
    await POST(postReq(gita()))
    const senzaDati = String(
      (scrittureSu('forms_templates')[0].valori[0] as Record<string, unknown>).description,
    )
    // Su un foglio che autorizza l'uscita di un minore, «Quota: —» si legge
    // come una quota decisa: la riga non c'è affatto.
    expect(senzaDati).not.toContain('Quota')
    expect(senzaDati).not.toContain('Accompagnatori')
  })

  it('attività in acqua ⇒ il modulo chiede «sa nuotare», altrimenti no', async () => {
    await POST(postReq(gita({ tipo_attivita: 'corso_piscina', attivita_in_acqua: true })))
    const campi = (scrittureSu('forms_templates')[0].valori[0] as { fields: { id: string }[] }).fields
    expect(campi.map((c) => c.id)).toEqual(['sa_nuotare', 'recapito_reperibile', 'autorizzazione'])

    h.db = dbBase()
    h.scritture = []
    await POST(postReq(gita()))
    const asciutti = (scrittureSu('forms_templates')[0].valori[0] as { fields: { id: string }[] }).fields
    expect(asciutti.map((c) => c.id)).toEqual(['recapito_reperibile', 'autorizzazione'])
  })
})

describe('POST /api/teacher/uscite — l’automatismo che si guasta non porta via la gita', () => {
  it('INSERT del modulo respinto ⇒ 201, uscita creata, e il CORPO dell’errore nel log', async () => {
    // `PGRST204` è il degrado noto del database E2E della CI (colonna assente),
    // cioè la forma di guasto che questa route incontrerà davvero.
    h.erroriTabella['forms_templates:insert'] = {
      code: 'PGRST204',
      message: "Could not find the 'target_classes' column of 'forms_templates'",
    }

    const res = await POST(postReq(gita()))

    // La gita si crea LO STESSO: un'insegnante deve poter programmare l'uscita
    // anche quando l'automatismo è rotto.
    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')).toHaveLength(1)
    expect(h.db.eventi_agenda).toHaveLength(1)

    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    expect(corpo.data.autorizzazione).toBeNull()
    // Il guasto è DICHIARATO nella risposta: un `null` muto si legge come
    // «non serviva».
    expect(corpo.data.esitoAutorizzazione).toBe('non-creata')

    // E lascia una riga di errore con dentro il corpo del guasto, non il solo
    // codice: `logErrore` riceve l'errore INTERO come secondo argomento.
    const chiamata = h.logErrore.mock.calls.find(
      (c: unknown[]) => (c[0] as { evento?: string })?.evento === 'autorizzazione-non-creata',
    )
    expect(chiamata?.[0]).toMatchObject({ operazione: 'teacher/uscite:POST' })
    expect(chiamata?.[1]).toMatchObject({
      code: 'PGRST204',
      message: "Could not find the 'target_classes' column of 'forms_templates'",
    })
    // Il successo della gita resta comunque registrato: «nessun log» non deve
    // poter significare tanto «tutto bene» quanto «non è mai partito niente».
    expect(rigaLog('uscita-creata')?.[1]).toBe('info')
  })

  it('lettura dei moduli esistenti fallita ⇒ NON si crea un secondo modulo alla cieca', async () => {
    // «Non lo so» qui vuol dire che il modulo POTREBBE già esserci: crearne un
    // altro manderebbe alla famiglia due moduli identici per lo stesso bambino.
    h.erroriTabella['forms_templates:select'] = { code: '42P01', message: 'relation does not exist' }

    const res = await POST(postReq(gita()))

    expect(res.status).toBe(201)
    expect(scrittureSu('forms_templates')).toEqual([])
    expect((await res.json()).data.esitoAutorizzazione).toBe('non-creata')
    expect(
      h.logErrore.mock.calls.some(
        (c: unknown[]) => (c[0] as { evento?: string })?.evento === 'autorizzazione-non-verificata',
      ),
    ).toBe(true)
  })
})

describe('POST /api/teacher/uscite — la seconda volta non duplica', () => {
  it('stessa gita creata due volte ⇒ una sola uscita e una sola autorizzazione', async () => {
    const primo = await POST(postReq(gita()))
    expect(primo.status).toBe(201)

    const secondo = await POST(postReq(gita()))

    // 200 e non 201: la seconda chiamata non ha creato niente.
    expect(secondo.status).toBe(200)
    expect(scrittureSu('eventi_agenda')).toHaveLength(1)
    expect(scrittureSu('forms_templates')).toHaveLength(1)
    expect(h.db.forms_templates).toHaveLength(1)
    expect(h.db.eventi_agenda).toHaveLength(1)

    const corpo = await secondo.json()
    expect(corpo.data.esitoAutorizzazione).toBe('gia-presente')
    expect(corpo.data.autorizzazione.id).toBe(h.db.forms_templates[0].id)
    expect(rigaLog('autorizzazione-uscita-gia-presente')?.[1]).toBe('info')
  })

  it('la gita che si allarga a una sezione nuova porta l’autorizzazione anche a quella', async () => {
    await POST(postReq(gita({ sezioni: [SEC_PICCOLI] })))
    h.scritture = []

    const res = await POST(postReq(gita({ sezioni: [SEC_PICCOLI, SEC_GRANDI] })))

    // L'uscita nasce per la sola sezione che ancora non ce l'aveva…
    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori).toHaveLength(1)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({ section_id: SEC_GRANDI })
    // …e l'autorizzazione pure: il modulo già scritto NON copre «GRANDI».
    // Il nuovo nomina la SOLA classe scoperta — se ripetesse anche «PICCOLI»,
    // quelle famiglie si troverebbero due moduli identici da firmare per lo
    // stesso bambino.
    const moduli = scrittureSu('forms_templates')
    expect(moduli).toHaveLength(1)
    expect((moduli[0].valori[0] as { target_classes: string[] }).target_classes).toEqual(['GRANDI'])
    // E nessuna classe resta senza: le due righe insieme coprono la gita.
    expect(
      h.db.forms_templates.flatMap((m) => (m as { target_classes: string[] }).target_classes).sort(),
    ).toEqual(['GRANDI', 'PICCOLI'])
  })
})

describe('POST /api/teacher/uscite — la sede si dichiara, le sezioni si verificano', () => {
  it('admin multi-sede senza `scuola_id` ⇒ 400 e NESSUNA scrittura', async () => {
    // `delete` e non destrutturazione-con-scarto: è l'idioma dei test di questo repo
    // (`staff-identity-riuso.test.ts`), e qui la variabile scartata farebbe scattare
    // `no-unused-vars`, che nei `__tests__` non ha la deroga sul prefisso `_`. Il tipo
    // largo serve perché `delete` vuole una proprietà facoltativa, e in `gita()` non lo è
    // — è proprio il punto: la sede c'è sempre, tranne in questa prova.
    const senzaSede: Record<string, unknown> = gita()
    delete senzaSede.scuola_id
    const res = await POST(postReq(senzaSede))

    expect(res.status).toBe(400)
    expect(scrittureSu('eventi_agenda')).toEqual([])
    expect(scrittureSu('forms_templates')).toEqual([])
  })

  it('SedeSelector su una sola sede ⇒ la dichiarazione non serve', async () => {
    const senzaSede: Record<string, unknown> = gita()
    delete senzaSede.scuola_id
    const res = await POST(postReq(senzaSede, SEDE_A))

    expect(res.status).toBe(201)
    expect(scrittureSu('forms_templates')[0].valori[0]).toMatchObject({ scuola_id: SEDE_A })
  })

  it('sezione di un altro plesso ⇒ 403 e nessuna autorizzazione spedita alle famiglie sbagliate', async () => {
    const res = await POST(postReq(gita({ sezioni: [SEC_PICCOLI, SEC_ALTRA_SEDE] })))

    expect(res.status).toBe(403)
    expect(scrittureSu('eventi_agenda')).toEqual([])
    expect(scrittureSu('forms_templates')).toEqual([])
  })

  it('educator: solo le proprie sezioni', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: ID_EDUCATOR, role: 'educator', scuola_id: SEDE_A },
    })

    const negato = await POST(postReq(gita({ sezioni: [SEC_GRANDI] })))
    expect(negato.status).toBe(403)
    expect(scrittureSu('forms_templates')).toEqual([])

    const concesso = await POST(postReq(gita({ sezioni: [SEC_PICCOLI] })))
    expect(concesso.status).toBe(201)
    expect(scrittureSu('forms_templates')).toHaveLength(1)
  })

  it('rientro prima della partenza ⇒ 400 prima di toccare il database', async () => {
    const res = await POST(postReq(gita({ ora_partenza: '16:00', ora_rientro: '08:30' })))

    expect(res.status).toBe(400)
    expect(h.scritture).toEqual([])
  })
})

describe('GET /api/teacher/uscite — il semaforo legge la firma della gita', () => {
  it('`form_id` ⇒ autorizzato è il bambino per cui esiste una firma', async () => {
    h.db.forms_submissions = [
      { id: 'sub-1', form_id: 'mod-gita', student_id: ALUNNO, is_signed: true },
    ]

    const res = await GET(getReq(`alunno_ids=${ALUNNO}&form_id=mod-gita`))

    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([
      { alunno_id: ALUNNO, autorizzato: true, quota_ok: false },
    ])
  })

  it('firma NON apposta ⇒ non autorizzato (il modulo compilato non basta)', async () => {
    h.db.forms_submissions = [
      { id: 'sub-1', form_id: 'mod-gita', student_id: ALUNNO, is_signed: false },
    ]

    const res = await GET(getReq(`alunno_ids=${ALUNNO}&form_id=mod-gita`))

    expect((await res.json()).data[0].autorizzato).toBe(false)
  })

  it('lettura delle firme fallita ⇒ 500, mai un «nessuno ha firmato» inventato', async () => {
    // Un dato sbagliato è peggio di un errore dichiarato: col silenzio
    // l'insegnante lascerebbe a scuola dei bambini autorizzati.
    h.erroriTabella['forms_submissions'] = { code: '42703', message: 'column does not exist' }

    const res = await GET(getReq(`alunno_ids=${ALUNNO}&form_id=mod-gita`))

    expect(res.status).toBe(500)
    expect(rigaLog('firme-uscita-non-lette')?.[1]).toBe('error')
  })
})
