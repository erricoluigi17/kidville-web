import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `POST /api/teacher/uscite` — la gita nasce, e con lei l'ANNUNCIO alle famiglie.
//
// ⚠️ QUESTO FILE È STATO RISCRITTO IL 2026-08-16, e la ragione va detta perché è
// la stessa che il critico ha contestato: fino al 15 agosto la route scriveva DUE
// righe — la gita in `eventi_agenda` e un modulo del **Sistema B** in
// `forms_templates` — e questo file misurava la seconda. La seconda non si scrive
// più (il prestampato n. 10 legge direttamente l'uscita), quindi nove prove su
// quindici misuravano una funzione cancellata: erano rosse, e una prova rossa
// lasciata rossa è un allarme che nessuno guarda più.
//
// Che cosa si misura adesso, e nessuna di queste è asserita a vuoto — il finto
// client FILTRA e SCRIVE davvero:
//
//  1. la gita nasce per le sezioni COINVOLTE, nella sede DICHIARATA, con dentro
//     i dati che il n. 10 rileggerà dalla descrizione (destinazione, orari,
//     mezzo, quota, accompagnatori);
//  2. **nessuna riga in `forms_templates`**: è il lock che impedisce al Sistema B
//     di tornare per distrazione, con due autorizzazioni per la stessa gita in
//     due archivi diversi;
//  3. l'annuncio parte — push e campanella, MAI email — e il suo SUCCESSO si
//     logga su un canale PERSISTITO: con i soli errori «nessun log» non
//     distingue «gli annunci partono» da «non ne è mai partito uno», che è
//     l'ambiguità che in questo progetto ha nascosto per mesi il guasto delle
//     email di credenziali;
//  4. il collegamento della notifica porta il genitore dove il modulo c'è
//     davvero, non su una scheda che gli dice «non hai moduli da compilare»;
//  5. se l'annuncio si guasta, la gita resta creata: un automatismo rotto non
//     può impedire a un'insegnante di programmare l'uscita;
//  6. la stessa gita creata due volte non annuncia due volte.
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
const ALUNNO_GRANDI = 'a2222222-0000-4000-8000-0000000000a2'
const GENITORE = 'c0000000-0000-4000-8000-00000000000c'
/** L'uscita già in agenda, quando il semaforo la interroga per id. */
const USCITA = 'e5555555-0000-4000-8000-0000000000e5'

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
  notificaEvento: vi.fn(),
  genitoriDiAlunni: vi.fn(),
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
// L'annuncio: si sostituiscono le due funzioni che escono dalla route, e non quello
// che c'è sotto. `notificaEvento` scrive la campanella e accoda la push — qui basta
// sapere CHE COSA le è stato chiesto, perché è l'unica cosa che questa route decide.
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiAlunni: h.genitoriDiAlunni }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.erroriTabella }),
  }
})

import { GET, POST } from '@/app/api/teacher/uscite/route'
import { vaPersistito } from '@/lib/logging/logger'
import { datiUscitaDaEvento } from '@/app/api/parent/prestampati/banco-famiglia'

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
  alunni: [
    // `stato` non è decorativo: la route filtra su `STATI_CON_CANALE_FAMIGLIA`, ed
    // è il predicato che tiene un ritirato fuori dalle notifiche di classe. `'iscritto'`
    // è il valore vero della tendina — non `'attivo'`, che non esiste.
    { id: ALUNNO, scuola_id: SEDE_A, section_id: SEC_PICCOLI, stato: 'iscritto' },
    { id: ALUNNO_GRANDI, scuola_id: SEDE_A, section_id: SEC_GRANDI, stato: 'iscritto' },
  ],
  student_documents: [],
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
/** La riga scritta in agenda, tale e quale: è ciò che il prestampato n. 10 rilegge. */
const eventoScritto = () =>
  scrittureSu('eventi_agenda')[0].valori[0] as {
    titolo: string
    descrizione: string
    data: string
    orario_inizio: string
    orario_fine: string
  }
const descrizioneScritta = (): string => String(eventoScritto().descrizione)
/** Che cosa è stato chiesto a `notificaEvento`, la prima volta. */
const annuncio = () => h.notificaEvento.mock.calls[0]?.[1] as Record<string, unknown> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroriTabella = {}
  h.requireDocente.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireUser.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.notificaEvento.mockResolvedValue(undefined)
  h.genitoriDiAlunni.mockResolvedValue([GENITORE])
})

describe('POST /api/teacher/uscite — la gita nasce, e il Sistema B non torna', () => {
  it('crea l’uscita per le sezioni coinvolte, e NESSUN modulo del Sistema B', async () => {
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

    /**
     * 🔴 IL LOCK CHE IMPEDISCE AL SISTEMA B DI TORNARE. Erano due sistemi che non si
     * parlavano e la famiglia li vedeva tutti e due: il prestampato n. 10 (carta intestata,
     * firma OTP, protocollo, fascicolo) restava spento, e accanto un modulo di
     * `forms_templates` chiedeva le stesse cose in un'altra schermata, si firmava altrove e
     * finiva in `forms_submissions` invece che nel fascicolo del bambino. Due autorizzazioni
     * per la stessa gita, con due valori diversi e due archivi diversi.
     */
    expect(scrittureSu('forms_templates')).toEqual([])
    expect(h.db.forms_templates).toEqual([])

    const corpo = await res.json()
    expect(corpo.data.uscita.create).toBe(2)
    expect(corpo.data.classi.sort()).toEqual(['GRANDI', 'PICCOLI'])
    expect(rigaLog('uscita-creata')?.[1]).toBe('info')
  })

  it('i dati della gita entrano nella descrizione, e il n. 10 li rilegge tali e quali', async () => {
    /**
     * ⚠️ È IL ROUND-TRIP, ed è l'unica cosa che tiene insieme le due metà: `eventi_agenda`
     * non ha una colonna `jsonb`, quindi i dati dell'uscita viaggiano dentro il TESTO della
     * descrizione. Chi scrive (questa route) e chi rilegge (`datiUscitaDaEvento`, le due
     * porte della famiglia) devono usare le stesse etichette, o il modulo n. 10 smette di
     * stampare la destinazione **senza che niente diventi rosso**.
     */
    await POST(postReq(gita({ quota: 12, accompagnatori: 'due insegnanti di sezione' })))

    const riletta = datiUscitaDaEvento(eventoScritto())
    expect(riletta?.tipo).toBe('gita')
    expect(riletta?.destinazione).toBe('Fattoria didattica')
    expect(riletta?.oraPartenza).toBe('08:30')
    expect(riletta?.oraRientro).toBe('16:00')
    expect(riletta?.mezzo).toBe('pullman_privato')

    // ⚠️ QUOTA E ACCOMPAGNATORI ENTRANO IN AGENDA MA NON SUL FOGLIO, ed è misurato non
    // supposto: `DatiUscita` non ha quei due campi e `datiUscitaDaEvento` non li rilegge —
    // sono dati di servizio della sezione, e sul foglio del n. 10 non compaiono. In agenda
    // però ci devono essere, perché è lì che l'insegnante li rilegge.
    expect(descrizioneScritta()).toContain('€ 12,00')
    expect(descrizioneScritta()).toContain('due insegnanti di sezione')
  })

  it('ciò che manca non lascia una riga vuota nella descrizione', async () => {
    await POST(postReq(gita()))
    // Su un foglio che autorizza l'uscita di un minore, «Quota: —» si legge
    // come una quota decisa: la riga non c'è affatto.
    expect(descrizioneScritta()).not.toContain('Quota')
    expect(descrizioneScritta()).not.toContain('Accompagnatori')
  })

  it('l’attività in acqua sopravvive alla scrittura: è il n. 10 a chiedere «sa nuotare»', async () => {
    await POST(postReq(gita({ tipo_attivita: 'corso_piscina', attivita_in_acqua: true })))
    expect(datiUscitaDaEvento(eventoScritto())?.attivitaInAcqua).toBe(true)

    h.db = dbBase()
    h.scritture = []
    await POST(postReq(gita()))
    expect(datiUscitaDaEvento(eventoScritto())?.attivitaInAcqua).toBe(false)
  })
})

describe('POST /api/teacher/uscite — l’annuncio alle famiglie', () => {
  it('push e campanella per le famiglie della sezione, e MAI un’email', async () => {
    const res = await POST(postReq(gita()))

    expect(res.status).toBe(201)
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect(annuncio()).toMatchObject({
      tipo: 'consenso_uscita',
      scuolaId: SEDE_A,
      utenteIds: [GENITORE],
      entitaTipo: 'eventi_agenda',
    })
    // I destinatari si ricavano dagli alunni della SEZIONE creata, non da tutta la sede.
    // ⚠️ Si legge l'ARGOMENTO e non si usa `toHaveBeenCalledWith(expect.anything(), …)`: il
    // primo argomento è il finto client, che è un `Proxy` con la sonda anti-silenzio, e
    // farlo ispezionare da `pretty-format` lo fa esplodere su `@@__IMMUTABLE_ITERABLE__@@`.
    expect(h.genitoriDiAlunni.mock.calls[0]?.[1]).toEqual([ALUNNO])
    expect((await res.json()).data.notificate).toBe(1)
  })

  it('il collegamento porta il genitore DOVE il modulo c’è davvero', async () => {
    /**
     * 🔴 Misurato in un browser vero: `/parent/modulistica` si apre sulla scheda «DA
     * COMPILARE», che allo stesso genitore diceva «Ottimo lavoro! Non hai moduli da
     * compilare» — mentre il modulo della gita stava nella terza scheda. E il testo nominava
     * una linguetta («Certificati») con un'etichetta che nell'app non esiste.
     */
    await POST(postReq(gita()))
    expect(String(annuncio()?.link)).toContain('tab=certificati')
  })

  it('la linguetta nominata nel link è una che la PAGINA accetta davvero', async () => {
    /**
     * ⚠️ IL LOCK STA A CAVALLO DEI DUE FILE, ed è l'unico modo di tenerlo fermo: il
     * collegamento lo compone questa route, la parola la riconosce
     * `parent/modulistica/page.tsx`, e finché nessuno mandava quel link il disallineamento
     * non si vedeva. Un `?tab=` che la pagina non conosce ricade su «Da compilare» **in
     * silenzio**, cioè riproduce esattamente il difetto che questo lavoro chiude — con in
     * più l'illusione, dal lato della route, di averlo risolto.
     */
    const fs = await import('node:fs')
    const path = await import('node:path')

    await POST(postReq(gita()))
    const tab = new URL(String(annuncio()?.link), 'http://localhost').searchParams.get('tab')
    expect(tab, 'il link non porta nessuna linguetta').toBeTruthy()

    const pagina = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(dashboard)/parent/modulistica/page.tsx'),
      'utf8',
    )
    expect(
      pagina,
      `\`page.tsx\` non riconosce \`?tab=${tab}\`: il genitore atterrerebbe su «Da compilare»`,
    ).toContain(`tabParam === '${tab}'`)
  })

  it('il SUCCESSO dell’annuncio finisce su un canale PERSISTITO, o non finisce da nessuna parte', async () => {
    /**
     * 🔴 IL DIFETTO, misurato su `app_log`: la riga di successo era
     * `logEvento('notifica','info',…)`, e `notifica` non è fra gli `EVENTI_PERSISTITI` — la
     * regola è `livello==='error' || 'warn' || EVENTI_PERSISTITI.has(evento)`. Per la gita
     * creata alle 00:16 in tabella c'erano SOLO due righe, e nessuna nominava l'annuncio.
     * Con trenta giorni di ritenzione e un giorno di log runtime su Vercel, fra una settimana
     * «nessuna riga» non distinguerebbe «gli annunci partono» da «non ne è mai partito uno»
     * — l'ambiguità che AGENTS.md §5 esiste per rompere, e la stessa che ha nascosto per
     * mesi il guasto delle email di credenziali.
     *
     * Non si asserisce IL NOME del canale ma la sua PROPRIETÀ, interrogando la funzione che
     * il logger usa davvero: così la prova resta vera anche se un giorno il canale cambia,
     * e resta rossa se il canale smette di essere persistito.
     */
    await POST(postReq(gita()))

    const riga = rigaLog('uscita-annunciata')
    expect(riga, JSON.stringify(h.logEvento.mock.calls.map((c: unknown[]) => c[2]))).toBeDefined()
    expect(
      vaPersistito(riga?.[1] as 'info' | 'warn' | 'error', riga?.[0] as string),
      `il canale \`${String(riga?.[0])}\` non è persistito: quella riga non arriva in \`app_log\``,
    ).toBe(true)
  })

  it('l’annuncio che si guasta non porta via la gita', async () => {
    // Un automatismo rotto non può impedire a un'insegnante di programmare l'uscita.
    h.notificaEvento.mockRejectedValue(new Error('coda delle push non raggiungibile'))

    const res = await POST(postReq(gita()))

    expect(res.status).toBe(201)
    expect(h.db.eventi_agenda).toHaveLength(1)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    expect(corpo.data.notificate).toBe(0)
    // E il guasto lascia la sua riga, col CORPO dell'errore: `403` non dice niente.
    const riga = rigaLog('uscita-non-annunciata')
    expect(riga?.[1]).toBe('error')
    // `JSON.stringify(new Error(…))` è `{}`: il messaggio si legge dalla proprietà.
    expect((riga?.[3] as Error)?.message).toContain('coda delle push')
  })

  it('destinatari non letti ⇒ la gita resta, e il guasto si vede', async () => {
    h.erroriTabella['alunni'] = { code: '42703', message: 'column does not exist' }

    const res = await POST(postReq(gita()))

    expect(res.status).toBe(201)
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(rigaLog('destinatari-non-letti')?.[1]).toBe('error')
  })
})

describe('POST /api/teacher/uscite — l’uscita che non si è potuta verificare', () => {
  it('lettura delle uscite esistenti fallita ⇒ 500, e NIENTE creato alla cieca', async () => {
    // «Non lo so» qui vuol dire che la gita POTREBBE già esserci: crearne un'altra
    // manderebbe alle stesse famiglie una seconda notifica per la stessa uscita.
    h.erroriTabella['eventi_agenda:select'] = { code: '42P01', message: 'relation does not exist' }

    const res = await POST(postReq(gita()))

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('USCITA_NON_VERIFICATA')
    expect(scrittureSu('eventi_agenda')).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
    expect(rigaLog('uscite-esistenti-non-lette')?.[1]).toBe('error')
  })
})

describe('POST /api/teacher/uscite — la seconda volta non annuncia di nuovo', () => {
  it('stessa gita creata due volte ⇒ una sola uscita e una sola notifica', async () => {
    const primo = await POST(postReq(gita()))
    expect(primo.status).toBe(201)

    const secondo = await POST(postReq(gita()))

    // 200 e non 201: la seconda chiamata non ha creato niente.
    expect(secondo.status).toBe(200)
    expect(scrittureSu('eventi_agenda')).toHaveLength(1)
    expect(h.db.eventi_agenda).toHaveLength(1)
    // E soprattutto: alle stesse famiglie non arriva una seconda campanella per
    // la stessa gita.
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect((await secondo.json()).data.notificate).toBe(0)
  })

  it('la gita che si allarga a una sezione nuova annuncia SOLO alle famiglie nuove', async () => {
    await POST(postReq(gita({ sezioni: [SEC_PICCOLI] })))
    h.scritture = []
    h.notificaEvento.mockClear()
    h.genitoriDiAlunni.mockClear()

    const res = await POST(postReq(gita({ sezioni: [SEC_PICCOLI, SEC_GRANDI] })))

    // L'uscita nasce per la sola sezione che ancora non ce l'aveva…
    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori).toHaveLength(1)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({ section_id: SEC_GRANDI })
    // …e la notifica pure: le famiglie di PICCOLI l'hanno già ricevuta, e una
    // seconda campanella identica si legge come una seconda gita.
    expect(h.genitoriDiAlunni.mock.calls[0]?.[1]).toEqual([ALUNNO_GRANDI])
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
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
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('SedeSelector su una sola sede ⇒ la dichiarazione non serve', async () => {
    const senzaSede: Record<string, unknown> = gita()
    delete senzaSede.scuola_id
    const res = await POST(postReq(senzaSede, SEDE_A))

    expect(res.status).toBe(201)
    expect(scrittureSu('eventi_agenda')[0].valori[0]).toMatchObject({ scuola_id: SEDE_A })
  })

  it('sezione di un altro plesso ⇒ 403 e nessun annuncio alle famiglie sbagliate', async () => {
    const res = await POST(postReq(gita({ sezioni: [SEC_PICCOLI, SEC_ALTRA_SEDE] })))

    expect(res.status).toBe(403)
    expect(scrittureSu('eventi_agenda')).toEqual([])
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('educator: solo le proprie sezioni', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: ID_EDUCATOR, role: 'educator', scuola_id: SEDE_A },
    })

    const negato = await POST(postReq(gita({ sezioni: [SEC_GRANDI] })))
    expect(negato.status).toBe(403)
    expect(scrittureSu('eventi_agenda')).toEqual([])

    const concesso = await POST(postReq(gita({ sezioni: [SEC_PICCOLI] })))
    expect(concesso.status).toBe(201)
    expect(scrittureSu('eventi_agenda')).toHaveLength(1)
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

describe('GET /api/teacher/uscite — il semaforo delle gite NUOVE legge il fascicolo', () => {
  /**
   * 🔴 IL DIFETTO CHE QUESTE PROVE CHIUDONO. Spento il Sistema B, era rimasto acceso il suo
   * unico lettore: la firma del prestampato n. 10 finisce in `student_documents`
   * (`document_type = 'autorizzazione_uscita'`) + `firme_documenti`, e nessuna delle due
   * tabelle che il GET interrogava contiene quella riga. Per ogni gita creata dal 2026-08-16
   * in poi il semaforo avrebbe detto «nessuno ha autorizzato» **anche con tutte le famiglie
   * che avevano firmato** — cioè, con le parole del commento della route stessa, «il giorno
   * dell'uscita l'insegnante lascerebbe a scuola dei bambini autorizzati».
   */
  const CREATA_IL = '2026-08-16T09:00:00.000Z'

  beforeEach(() => {
    h.db.eventi_agenda = [
      {
        id: USCITA,
        scuola_id: SEDE_A,
        section_id: SEC_PICCOLI,
        tipo: 'uscita',
        data: GIORNO_GITA,
        creato_il: CREATA_IL,
      },
    ]
  })

  it('`uscita_id` ⇒ autorizzato è il bambino con l’autorizzazione nel fascicolo', async () => {
    h.db.student_documents = [
      {
        id: 'doc-1',
        student_id: ALUNNO,
        document_type: 'autorizzazione_uscita',
        created_at: '2026-08-17T10:00:00.000Z',
      },
    ]

    const res = await GET(getReq(`alunno_ids=${ALUNNO},${ALUNNO_GRANDI}&uscita_id=${USCITA}`))

    expect(res.status).toBe(200)
    const dati = (await res.json()).data as { alunno_id: string; autorizzato: boolean }[]
    expect(dati.find((d) => d.alunno_id === ALUNNO)?.autorizzato).toBe(true)
    expect(dati.find((d) => d.alunno_id === ALUNNO_GRANDI)?.autorizzato).toBe(false)
  })

  it('un’autorizzazione firmata PRIMA che la gita esistesse non vale per questa gita', async () => {
    // È il limite noto, e il modo in cui lo si stringe: il documento nel fascicolo non è
    // legato all'evento, quindi la sola cosa che si può pretendere è che la firma sia
    // successiva all'annuncio. Senza questo confine, l'autorizzazione della gita di marzo
    // manderebbe un bambino in gita a maggio senza che nessuno abbia firmato niente.
    h.db.student_documents = [
      {
        id: 'doc-vecchio',
        student_id: ALUNNO,
        document_type: 'autorizzazione_uscita',
        created_at: '2026-05-02T10:00:00.000Z',
      },
    ]

    const res = await GET(getReq(`alunno_ids=${ALUNNO}&uscita_id=${USCITA}`))

    expect((await res.json()).data[0].autorizzato).toBe(false)
  })

  it('un documento di un ALTRO tipo non è un’autorizzazione all’uscita', async () => {
    h.db.student_documents = [
      {
        id: 'doc-sanitario',
        student_id: ALUNNO,
        document_type: 'scheda_sanitaria',
        created_at: '2026-08-17T10:00:00.000Z',
      },
    ]

    const res = await GET(getReq(`alunno_ids=${ALUNNO}&uscita_id=${USCITA}`))

    expect((await res.json()).data[0].autorizzato).toBe(false)
  })

  it('lettura del fascicolo fallita ⇒ 500, mai un «nessuno ha firmato» inventato', async () => {
    h.erroriTabella['student_documents'] = { code: '22P02', message: 'invalid input value for enum' }

    const res = await GET(getReq(`alunno_ids=${ALUNNO}&uscita_id=${USCITA}`))

    expect(res.status).toBe(500)
    expect(rigaLog('firme-uscita-non-lette')?.[1]).toBe('error')
  })

  it('un’uscita che non esiste NON diventa un elenco di «non autorizzati»', async () => {
    // Senza l'uscita non c'è nemmeno l'istante da cui contare le firme: l'unica alternativa
    // a dichiararlo sarebbe stata contarle tutte, cioè dire «autorizzato» a chi ha firmato
    // per la gita di marzo. Un elenco che non si può calcolare si dichiara, non si stima.
    const res = await GET(getReq(`alunno_ids=${ALUNNO}&uscita_id=e9999999-0000-4000-8000-0000000000e9`))

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('AUTORIZZAZIONI_USCITA_NON_LETTE')
    // La DIAGNOSI esatta sta nel log, che è dove serve — non nella frase mostrata.
    expect(rigaLog('uscita-non-trovata')?.[1]).toBe('warn')
  })
})
