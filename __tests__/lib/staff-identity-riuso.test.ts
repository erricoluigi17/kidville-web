import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `seEsisteRiusa`: l'opzione che rende `ensureStaffIdentity` usabile ANCHE per
// chi l'account ce l'ha già — senza toccare di un byte ciò che fa per le
// candidature.
//
// I TRE DIFETTI REALI CHE QUESTO FILE IMPEDISCE.
//
//  1. IL MODULO INUTILIZZABILE PER LE PERSONE A CUI È DESTINATO.
//     `/anagrafica-personale` è per le insegnanti GIÀ DIPENDENTI: la maestra che
//     compila la pratica lavora qui da anni e in `utenti` c'è già. Con la sola
//     porta chiusa di sempre, approvare quella pratica risponde
//     `email_gia_staff` — cioè il modulo respinge il caso normale e ne accetta
//     solo uno che non esiste. Qui si tiene fermo che con l'opzione accesa la
//     risposta è `ok:true, riusato:true`, e che NON viene scritto niente.
//
//  2. LA PORTA DEL GENITORE SCAVALCATA MENTRE SE NE APRIVA UN'ALTRA, che è il
//     modo peggiore di sbagliare perché nessuno l'ha decisa. Una madre in
//     `utenti` c'è già — `ruolo: 'genitore'`, la scrive `ensureParentIdentity` —
//     quindi per lei il controllo per EMAIL esce PRIMA che il controllo su
//     `parents` venga raggiunto. Senza un diniego esplicito sul ruolo, l'opzione
//     avrebbe attaccato l'anagrafica del PERSONALE all'uid di un genitore, in
//     una tabella che dichiara «personale in servizio». Qui la porta si prova
//     chiusa da ENTRAMBE le strade, `parents` e `ruolo`.
//
//  3. IL RIUSO DEDOTTO DA `createdAuth === false`, che è la deduzione sbagliata
//     nel caso che capita di più: account `auth.users` preesistente e riga
//     `utenti` creata ADESSO. Chi leggesse `createdAuth` come «c'era già tutto»
//     salterebbe la scrittura dell'anagrafica per una persona appena creata. Due
//     domande diverse, due campi: `riusato` esiste per questo, e qui si prova che
//     in quel caso NON c'è.
//
// COME SI PROVA. Il client Supabase è finto ma le SCRITTURE si registrano: ogni
// caso che dice «non si tocca niente» lo dimostra sugli INSERT e sulle
// `createUser` osservate, non sul valore di ritorno — un `ok:false` con dietro
// una riga scritta sarebbe verde su un test che guarda solo l'esito.
// =============================================================================

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logOk: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logOk: h.logOk,
  logErrore: h.logErrore,
}))

import { ensureStaffIdentity } from '@/lib/auth/staff-identity'

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const EMAIL = 'maestra.prova@example.test'
const UID_STAFF = '11111111-0000-4000-8000-00000000000a'
const UID_GENITORE = '22222222-0000-4000-8000-00000000000b'

const stato = {
  utenti: [] as Riga[],
  parents: [] as Riga[],
  authUsers: [] as { id: string; email: string }[],
  /** Ogni INSERT osservato: è così che «zero scritture» diventa una misura. */
  inserimenti: [] as { tabella: string; riga: Riga }[],
  /** Ogni account nato: un riuso che crea un account è un registro diviso in due. */
  creazioniAuth: [] as string[],
}

/**
 * Client finto che risponde alle QUATTRO letture di `ensureStaffIdentity`:
 * `utenti` per email (`.in`), `parents` per uid, `utenti` per uid, e l'INSERT.
 * Non simula PostgREST in generale — simula queste, ed è quanto basta perché
 * i filtri applicati sono l'oggetto del test.
 *
 * ⚠️ LA PROIEZIONE SI APPLICA DAVVERO, e non è un dettaglio del finto: è la
 * differenza fra un test che prova qualcosa e uno che si autoconferma. La prima
 * stesura di questo file aveva `select = () => b`, cioè ignorava l'elenco delle
 * colonne e restituiva la riga INTERA. Misurato: togliendo `scuola_id` dalla
 * `select()` del codice — che in produzione significa `scuolaIdEsistente` sempre
 * `null`, cioè la dichiarazione della sede MORTA — i test della sede restavano
 * tutti e quattro VERDI. Con la proiezione applicata quella stessa mutazione ne
 * fa cadere tre. Una colonna che il codice non CHIEDE non deve arrivare.
 */
function admin(): SupabaseClient {
  const righe = (t: string): Riga[] => (t === 'utenti' ? stato.utenti : t === 'parents' ? stato.parents : [])
  /** Solo le colonne chieste, come fa PostgREST. `*` (o nessuna) = tutta la riga. */
  const proietta = (riga: Riga, cols: string | undefined): Riga => {
    const chieste = (cols ?? '*').split(',').map((c) => c.trim()).filter(Boolean)
    if (chieste.includes('*')) return riga
    return Object.fromEntries(chieste.filter((c) => c in riga).map((c) => [c, riga[c]]))
  }
  return {
    from(tabella: string) {
      const filtri: Filtro[] = []
      let inserimento: Riga | null = null
      let proiezione: string | undefined
      const esegui = () => {
        if (inserimento) {
          const riga = { ...inserimento }
          stato.inserimenti.push({ tabella, riga })
          righe(tabella).push(riga)
          return { data: [proietta(riga, proiezione)], error: null }
        }
        const trovate = righe(tabella)
          .filter((r) => filtri.every((f) => f.vals.some((v) => r[f.col] === v)))
          .map((r) => proietta(r, proiezione))
        return { data: trovate, error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { proiezione = cols; return b }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.limit = () => b
      b.insert = (v: Riga) => { inserimento = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      return b
    },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: stato.authUsers }, error: null }),
        createUser: async ({ email }: { email: string }) => {
          stato.creazioniAuth.push(email)
          const u = { id: `auth-nuovo-${stato.creazioniAuth.length}`, email }
          stato.authUsers.push(u)
          return { data: { user: u }, error: null }
        },
      },
    },
  } as unknown as SupabaseClient
}

const INPUT = {
  email: EMAIL,
  nome: 'Prova',
  cognome: 'Cognome',
  cellulare: null,
  ruolo: 'educator' as const,
  scuolaId: SEDE_A,
  gradi: ['nido' as const],
}

const chiama = (opzioni?: { seEsisteRiusa?: boolean }) =>
  opzioni ? ensureStaffIdentity(admin(), INPUT, opzioni) : ensureStaffIdentity(admin(), INPUT)

/** La riga di log con quell'`esito`, se è stata emessa. */
const log = (esito: string) =>
  h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

/** «Non è stato toccato niente», misurato invece che promesso. */
function nessunaScrittura() {
  expect(stato.inserimenti, 'una riga scritta su un percorso che dichiara di non scrivere').toEqual([])
  expect(stato.creazioniAuth, 'un account creato su un percorso che dichiara di non crearne').toEqual([])
}

/** Il profilo del personale che esiste già: è il caso normale del nuovo modulo. */
const PROFILO_STAFF = {
  id: UID_STAFF,
  email: EMAIL,
  ruolo: 'educator',
  nome: 'Prova',
  cognome: 'Cognome',
  scuola_id: SEDE_A,
}

beforeEach(() => {
  vi.clearAllMocks()
  stato.utenti = []
  stato.parents = []
  stato.authUsers = []
  stato.inserimenti = []
  stato.creazioniAuth = []
})

describe('ensureStaffIdentity · l’opzione è SPENTA di default (le candidature non cambiano)', () => {
  it('email già di uno STAFF, senza opzioni: `email_gia_staff`, esattamente come prima', async () => {
    // È il contratto dell'approvazione delle CANDIDATURE, che chiama con due
    // argomenti: una candidatura di chi è già dentro resta un errore, e la
    // segreteria continua a leggere il suo 409 col ruolo di chi occupa l'email.
    stato.utenti = [{ ...PROFILO_STAFF, ruolo: 'segreteria' }]
    const r = await chiama()
    expect(r).toMatchObject({ ok: false, reason: 'email_gia_staff', ruoloEsistente: 'segreteria' })
    nessunaScrittura()

    // …e la porta chiusa resta CONTABILE: è la query con cui ci si accorge che
    // qualcuno sta creando account doppi.
    const chiusa = log('email-gia-staff')
    expect(chiusa, 'la porta chiusa non lascia più traccia: il conteggio perde una riga').toBeTruthy()
    expect(chiusa![1]).toBe('warn')
    expect(log('identita-staff-riusata'), 'riuso concesso SENZA che nessuno lo abbia chiesto').toBeFalsy()
  })

  it('opzione passata a `false`: identica alla chiamata senza opzioni', async () => {
    stato.utenti = [PROFILO_STAFF]
    const r = await chiama({ seEsisteRiusa: false })
    expect(r).toMatchObject({ ok: false, reason: 'email_gia_staff' })
    nessunaScrittura()
  })

  it('uid già in `utenti` (email archiviata con altre MAIUSCOLE), senza opzioni: `email_gia_staff`', async () => {
    // Il secondo dei due rami che l'opzione apre, e ci si arriva solo per uid:
    // il confronto per email non riconosce `Maestra.Prova@Example.test`.
    stato.authUsers = [{ id: UID_STAFF, email: EMAIL }]
    stato.utenti = [{ ...PROFILO_STAFF, email: 'Maestra.Prova@Example.test' }]
    const r = await chiama()
    expect(r).toMatchObject({ ok: false, reason: 'email_gia_staff' })
    expect(log('uid-gia-staff'), 'il ramo per UID non è stato raggiunto: il test non prova niente').toBeTruthy()
    nessunaScrittura()
  })
})

describe('ensureStaffIdentity · `seEsisteRiusa` acceso', () => {
  it('email già di uno STAFF: `ok:true` con `riusato`, nessuna password e ZERO scritture', async () => {
    stato.utenti = [PROFILO_STAFF]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r.ok, 'la pratica della maestra che lavora qui da anni viene respinta').toBe(true)
    if (!r.ok) throw new Error('atteso ok')
    // L'uid è quello del profilo TROVATO: è la chiave con cui il chiamante scrive
    // `anagrafica_personale.utente_id` (PK e FK su `utenti(id)`).
    expect(r.authUserId).toBe(UID_STAFF)
    expect(r.riusato).toBe(true)
    expect(r.createdAuth).toBe(false)
    // Nessuna password: non è nato nessun account, e spedire una password vuota a
    // una persona vera sarebbe il peggiore degli esiti.
    expect(r.password, 'una password per un account che non è nato adesso').toBeNull()
    // I `gradi` passati in `input` NON sono stati scritti: la riga c'era già.
    // Dirli scritti significherebbe promettere che le fasce d'età sono finite da
    // qualche parte, e il chiamante non avviserebbe che vanno assegnate a mano.
    expect(r.gradiScritti).toBe(false)

    nessunaScrittura()
    expect(stato.utenti, 'il profilo esistente è stato duplicato o riscritto').toHaveLength(1)
    expect(stato.utenti[0]).toEqual(PROFILO_STAFF)
  })

  it('il riuso lascia una riga di log, dice da QUALE porta è passato e non porta PII', async () => {
    stato.utenti = [PROFILO_STAFF]
    await chiama({ seEsisteRiusa: true })

    const riga = log('identita-staff-riusata')
    expect(riga, 'l’identità riusata non lascia nessuna traccia').toBeTruthy()
    expect(riga![0]).toBe('anagrafica')
    // `info` e non `warn`: col riuso acceso non è un'anomalia, ed emetterlo a
    // `warn` falserebbe il conteggio delle porte VERE chiuse.
    expect(riga![1]).toBe('info')
    const ctx = riga![2] as Record<string, unknown>
    expect(ctx.utente).toBe(UID_STAFF)
    expect(ctx.ruolo).toBe('educator')
    expect(ctx.tipo, 'la porta da cui è passato: «email» dice come è archiviato l’indirizzo').toBe('email')

    // Mai dati personali nei log: l'email della persona non compare da nessuna
    // parte nel contesto, per nessuna chiave.
    expect(JSON.stringify(ctx), 'un indirizzo email in chiaro nel contesto del log').not.toMatch(/example\.test/i)

    // E la porta chiusa NON si registra: dichiarare `email-gia-staff` su una
    // chiamata andata a buon fine sporcherebbe proprio il conteggio degli account
    // doppi tentati.
    expect(log('email-gia-staff'), 'porta dichiarata chiusa su un riuso riuscito').toBeFalsy()
  })

  it('uid già in `utenti` con l’email in ALTRE maiuscole: riuso per UID, e il log lo distingue', async () => {
    stato.authUsers = [{ id: UID_STAFF, email: EMAIL }]
    stato.utenti = [{ ...PROFILO_STAFF, email: 'Maestra.Prova@Example.test' }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r).toMatchObject({ ok: true, authUserId: UID_STAFF, riusato: true, password: null })
    nessunaScrittura()

    const riga = log('identita-staff-riusata')
    expect(riga, 'il ramo per UID non riusa: la pratica di chi ha l’email scritta in un altro caso viene respinta').toBeTruthy()
    // «uid» e non «email»: le due cose dicono qualcosa di diverso su com'è
    // archiviato quell'indirizzo, e confonderle nel log toglie l'unico indizio
    // che porta all'indice su `lower(email)` che ancora manca.
    expect((riga![2] as { tipo?: string }).tipo).toBe('uid')
    expect(log('uid-gia-staff'), 'porta dichiarata chiusa su un riuso riuscito').toBeFalsy()
  })

  it('uid legato a `parents`: `email_gia_genitore` ANCHE con l’opzione accesa', async () => {
    // La porta che non si apre. La stessa persona può essere maestra e madre di un
    // iscritto: dare a quell'uid il profilo del personale le darebbe l'anagrafica
    // di tutti i bambini, oppure le toglierebbe l'accesso ai propri figli. È una
    // decisione che prende una persona, non una route — e l'opzione non la prende.
    stato.authUsers = [{ id: UID_GENITORE, email: EMAIL }]
    stato.parents = [{ id: 'parent-1', auth_user_id: UID_GENITORE }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r).toMatchObject({ ok: false, reason: 'email_gia_genitore', ruoloEsistente: 'genitore' })
    if (r.ok) throw new Error('atteso errore')
    expect(r.message).toMatch(/genitore/i)
    // Il messaggio esce tale e quale nella risposta HTTP: nessun indirizzo dentro.
    expect(r.message, 'l’email di una persona vera nel messaggio servito al client').not.toMatch(/example\.test/i)
    nessunaScrittura()
  })

  it('profilo `utenti` con ruolo `genitore` trovato per EMAIL: riuso NEGATO, e `parents` è vuota', async () => {
    // IL RAMO CHE TIENE CHIUSA LA PORTA DAVVERO, e che senza un diniego esplicito
    // sul ruolo non esisterebbe. Qui `parents` è VUOTA di proposito: il controllo
    // del punto 3 non può salvare niente, perché per una madre il confronto per
    // EMAIL esce prima — la sua riga `utenti` la scrive `ensureParentIdentity`, con
    // `ruolo: 'genitore'`, e ha lo stesso indirizzo. Se questo caso tornasse
    // `ok:true`, l'anagrafica del PERSONALE finirebbe sull'uid di un genitore.
    stato.utenti = [{ ...PROFILO_STAFF, id: UID_GENITORE, ruolo: 'genitore' }]
    expect(stato.parents, 'con una riga in `parents` il test proverebbe l’altro ramo').toEqual([])

    const r = await chiama({ seEsisteRiusa: true })
    expect(r).toMatchObject({ ok: false, reason: 'email_gia_genitore', ruoloEsistente: 'genitore' })
    nessunaScrittura()

    const negato = log('riuso-negato-profilo-genitore')
    expect(negato, 'il diniego non lascia traccia: è la decisione più delicata di questa funzione').toBeTruthy()
    expect(negato![1]).toBe('warn')
    expect((negato![2] as { utente?: string }).utente).toBe(UID_GENITORE)
    expect(log('identita-staff-riusata'), 'riuso concesso sull’uid di un genitore').toBeFalsy()
  })

  it('lo stesso profilo `genitore` trovato per UID: negato pure lì, con la stessa risposta', async () => {
    // La regola vale per due strade e vive in un posto solo: se un domani ne
    // toccassero una sola, questa riga diventa rossa.
    stato.authUsers = [{ id: UID_GENITORE, email: EMAIL }]
    stato.utenti = [{ ...PROFILO_STAFF, id: UID_GENITORE, email: 'Maestra.Prova@Example.test', ruolo: 'genitore' }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r).toMatchObject({ ok: false, reason: 'email_gia_genitore' })
    expect((log('riuso-negato-profilo-genitore')![2] as { tipo?: string }).tipo).toBe('uid')
    nessunaScrittura()
  })
})

describe('ensureStaffIdentity · `riusato` risponde a una domanda che `createdAuth` non risponde', () => {
  it('identità NUOVA con l’opzione accesa: si crea come sempre, e `riusato` NON c’è', async () => {
    const r = await chiama({ seEsisteRiusa: true })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('atteso ok')
    expect(r.createdAuth).toBe(true)
    expect(typeof r.password).toBe('string')
    expect(r.riusato, 'una creazione dichiarata «riuso»: il chiamante salterebbe la scrittura').toBeUndefined()
    expect(r.gradiScritti).toBe(true)

    // Il profilo nasce con la sede DICHIARATA e senza le colonne generate.
    expect(stato.inserimenti).toHaveLength(1)
    const riga = stato.inserimenti[0].riga
    expect(stato.inserimenti[0].tabella).toBe('utenti')
    expect(riga.scuola_id).toBe(SEDE_A)
    expect(riga.ruolo).toBe('educator')
    for (const generata of ['role', 'first_name', 'last_name']) {
      expect(generata in riga, `scritta la colonna generata «${generata}»`).toBe(false)
    }
  })

  it('account `auth.users` PREESISTENTE e profilo `utenti` nato adesso: `createdAuth:false` ma NESSUN riuso', async () => {
    // È il caso per cui `riusato` esiste come campo a parte. L'account di login
    // c'era (quindi `createdAuth` è `false`), ma il profilo del personale è nato
    // in questa chiamata: chi deducesse il riuso da `createdAuth === false`
    // tratterebbe questa persona come «c'era già tutto» e non le scriverebbe mai
    // l'anagrafica. Due domande diverse non si rispondono con un campo solo.
    stato.authUsers = [{ id: UID_STAFF, email: EMAIL }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('atteso ok')
    expect(r.createdAuth, 'l’account preesistente non è stato riconosciuto: il test non prova niente').toBe(false)
    expect(r.password).toBeNull()
    expect(r.riusato, '«account riusato» spacciato per «profilo riusato»').toBeUndefined()

    // La prova che il profilo è NATO adesso, e sull'uid dell'account esistente.
    expect(stato.inserimenti).toHaveLength(1)
    expect(stato.inserimenti[0].riga.id).toBe(UID_STAFF)
    expect(stato.creazioniAuth, 'un secondo account su un’email che ne aveva già uno').toEqual([])

    // E i due FATTI del riuso non ci sono, perché non c'è niente di preesistente
    // da dichiarare: ruolo e sede sono quelli di `input`, appena scritti.
    expect(r.ruoloEsistente, 'un «ruolo esistente» su un profilo nato adesso').toBeUndefined()
    expect(r.scuolaIdEsistente, 'una «sede esistente» su un profilo nato adesso').toBeUndefined()
  })
})

// =============================================================================
// IL DINIEGO DEL GENITORE ERA FAIL-OPEN, e questo blocco è la rete che gli manca.
//
// IL DIFETTO REALE. Il confronto era `profilo.ruolo === 'genitore'`: esatto,
// sensibile alle maiuscole, su una colonna che il database NON vincola. Misurato
// in produzione l'11/08/2026 (sole SELECT): `utenti.ruolo` è
// `character varying NOT NULL` e gli unici vincoli della tabella sono la PK su
// `id`, l'UNIQUE su `email` e le due chiavi esterne — nessun `CHECK`, nessun
// enum. Scritto come diniego, quel confronto CONCEDEVA a tutto il resto:
// `'Genitore'`, uno spazio in coda, o un ruolo aggiunto domani aprivano la porta
// e tornavano `ok:true, riusato:true`.
//
// PERCHÉ NON C'ERA UNA SECONDA RETE. Per una madre trovata per EMAIL il controllo
// su `parents` (punto 3) non viene MAI raggiunto: la sua riga `utenti` esiste già
// e il punto 1 esce per primo. E non è un caso di scuola — in produzione c'è 1
// riga con `ruolo='genitore'` e NESSUNA riga `parents` corrispondente: per quella
// persona funziona SOLO questo confronto.
//
// Qui si tiene fermo il rovesciamento: si riusa chi ha un ruolo del PERSONALE, e
// chiunque altro — comprese le forme che nessuno ha previsto — NON passa.
// =============================================================================

/** I sei valori di `AppRole`: l'elenco è chiuso, e il riuso deve dire di sì a cinque. */
const RUOLI_PERSONALE = ['educator', 'segreteria', 'admin', 'coordinator', 'cuoca'] as const

describe('ensureStaffIdentity · il riuso ammette il PERSONALE, non «tutto ciò che non è genitore»', () => {
  for (const ruolo of RUOLI_PERSONALE) {
    it(`ruolo «${ruolo}»: riusato`, async () => {
      // I cinque ruoli del personale esistono tutti in produzione (educator 12 ·
      // segreteria 3 · admin 3 · cuoca 1 · coordinator 1): un elenco di ammessi
      // che ne dimenticasse uno bloccherebbe la pratica di una persona vera.
      stato.utenti = [{ ...PROFILO_STAFF, ruolo }]
      const r = await chiama({ seEsisteRiusa: true })
      expect(r, `il ruolo «${ruolo}» è del personale e il riuso lo respinge`)
        .toMatchObject({ ok: true, riusato: true, ruoloEsistente: ruolo })
      nessunaScrittura()
    })
  }

  for (const [etichetta, ruolo] of [
    ['maiuscola iniziale', 'Genitore'],
    ['tutto maiuscolo', 'GENITORE'],
    ['spazio in coda', 'genitore '],
    ['spazio davanti', ' genitore'],
  ] as const) {
    it(`«${ruolo}» (${etichetta}): è la stessa persona, e la porta resta CHIUSA`, async () => {
      // Prima della normalizzazione ognuna di queste quattro forme tornava
      // `ok:true, riusato:true`: l'anagrafica del PERSONALE sarebbe finita
      // sull'uid di un genitore per via di una maiuscola.
      stato.utenti = [{ ...PROFILO_STAFF, id: UID_GENITORE, ruolo }]
      const r = await chiama({ seEsisteRiusa: true })

      expect(r, `«${ruolo}» ha scavalcato il diniego del genitore`)
        .toMatchObject({ ok: false, reason: 'email_gia_genitore' })
      nessunaScrittura()

      const negato = log('riuso-negato-profilo-genitore')
      expect(negato, 'il diniego non è passato di qui: la porta l’ha chiusa qualcos’altro').toBeTruthy()
      // Nel log il ruolo NORMALIZZATO: è il valore su cui la decisione è stata
      // presa, ed è ciò che rende confrontabili fra loro le righe di questa query.
      expect((negato![2] as { ruolo?: string }).ruolo).toBe('genitore')
      expect(log('identita-staff-riusata'), 'riuso concesso sull’uid di un genitore').toBeFalsy()
    })
  }

  for (const [etichetta, ruolo] of [
    ['un ruolo che nasce domani', 'tirocinante'],
    ['una stringa vuota', ''],
    // La trappola vera, e non è teorica: su un oggetto letterale
    // `({educator:true})['toString']` NON è `undefined`, è la funzione ereditata
    // dal prototipo — cioè un valore VERO. Verificato in `node`. Con un elenco di
    // ammessi tenuto in un oggetto, un ruolo scritto così avrebbe superato il
    // controllo; con un `Set`, `has('toString')` è `false`.
    ['una chiave del prototipo', 'toString'],
    ['un’altra chiave del prototipo', 'constructor'],
  ] as const) {
    it(`«${ruolo || '(vuoto)'}» (${etichetta}): NON si riusa, e vale la porta chiusa di sempre`, async () => {
      stato.utenti = [{ ...PROFILO_STAFF, ruolo }]
      const r = await chiama({ seEsisteRiusa: true })

      // Non sapere è motivo per fermarsi — la stessa regola che questo file si dà
      // quando la lettura di `utenti` fallisce. La risposta è quella che riceve
      // anche il percorso delle candidature: collegare l'account a mano.
      expect(r, `il ruolo sconosciuto «${ruolo}» ha aperto la porta`)
        .toMatchObject({ ok: false, reason: 'email_gia_staff' })
      nessunaScrittura()

      const negato = log('riuso-negato-ruolo-non-riconosciuto')
      expect(negato, 'una riga `utenti` con un ruolo fuori dai sei noti non lascia traccia').toBeTruthy()
      // `warn` e non `info`: qui l'anomalia c'è davvero (un ruolo che nessuno ha
      // previsto in una colonna senza `CHECK`), e solo `warn` arriva in `app_log`,
      // che è l'unico posto in cui la si può contare.
      expect(negato![1]).toBe('warn')
      expect((negato![2] as { tipo?: string }).tipo).toBe('email')
      expect(log('identita-staff-riusata'), 'riuso concesso a un ruolo non riconosciuto').toBeFalsy()
    })
  }

  it('ruolo sconosciuto trovato per UID: negato pure lì', async () => {
    stato.authUsers = [{ id: UID_STAFF, email: EMAIL }]
    stato.utenti = [{ ...PROFILO_STAFF, email: 'Maestra.Prova@Example.test', ruolo: 'tirocinante' }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r).toMatchObject({ ok: false, reason: 'email_gia_staff' })
    expect((log('riuso-negato-ruolo-non-riconosciuto')![2] as { tipo?: string }).tipo).toBe('uid')
    nessunaScrittura()
  })

  it('ruolo sconosciuto SENZA l’opzione: `email_gia_staff` e NESSUNA riga di diniego', async () => {
    // Il percorso delle CANDIDATURE non passa mai per la decisione sul ruolo: si
    // esce prima. Se questa riga diventasse rossa vorrebbe dire che il nuovo log
    // si è messo a battere su una strada che non riusa niente — rumore in
    // `app_log` su ogni 409 di candidatura, cioè l'evento più frequente di quella
    // rotta.
    stato.utenti = [{ ...PROFILO_STAFF, ruolo: 'tirocinante' }]
    const r = await chiama()
    expect(r).toMatchObject({ ok: false, reason: 'email_gia_staff', ruoloEsistente: 'tirocinante' })
    expect(log('riuso-negato-ruolo-non-riconosciuto'), 'il diniego del riuso batte su una strada che non riusa').toBeFalsy()
    nessunaScrittura()
  })

  it('«Educator» con la maiuscola: la normalizzazione vale in ENTRAMBE le direzioni', async () => {
    // La normalizzazione non serve solo a negare di più: senza, una riga scritta a
    // mano come `'Educator'` avrebbe fatto respingere la pratica di una maestra
    // vera con un `email_gia_staff` che nessuno avrebbe saputo spiegare.
    stato.utenti = [{ ...PROFILO_STAFF, ruolo: 'Educator' }]
    const r = await chiama({ seEsisteRiusa: true })
    expect(r).toMatchObject({ ok: true, riusato: true })
    if (!r.ok) throw new Error('atteso ok')
    // Il ruolo torna CANONICO: chi lo riscrive altrove non propaga la variante.
    expect(r.ruoloEsistente).toBe('educator')
  })
})

// =============================================================================
// LA SEDE SCARTATA IN SILENZIO — il secondo pezzo di `input` che il riuso butta
// via, e che fino a ora non aveva nessun modo di essere visto.
//
// IL DIFETTO REALE. Sul riuso `input.scuolaId` non viene scritto (giusto: la riga
// `utenti` c'era già), ma l'informazione non era nemmeno DISPONIBILE — le due
// SELECT chiedevano `id, ruolo, email` e `id, ruolo`, e `scuola_id` non veniva
// mai letta. Intanto `anagrafica_personale` NON ha una `scuola_id` per scelta
// dichiarata nel DDL: la sede del personale È `utenti.scuola_id`, mentre
// `pratiche_personale.scuola_id` è NOT NULL e dice la sede della PRATICA.
//
// COSA SUCCEDEVA. La segreteria di un plesso approva una pratica che dichiara il
// proprio plesso, riceve `ok:true`, e la persona resta agganciata a un altro — in
// silenzio, senza che la route abbia un appiglio per accorgersene. Misurato in
// produzione l'11/08/2026: 20 persone distribuite su 4 `scuola_id` distinti,
// quindi la divergenza è possibile oggi, non domani. AGENTS.md lo vieta alla
// lettera: «una route che "indovina" la sede archivia i dati nel plesso sbagliato
// in silenzio. Ogni scrittura dichiara la sua sede».
//
// QUI NON SI PRETENDE CHE LA FUNZIONE DECIDA: uno spostamento di plesso è
// legittimo e lo scrive chi ha il gate. Si pretende che lo DICA — nel valore di
// ritorno e in una riga di log che finisce in tabella.
// =============================================================================
describe('ensureStaffIdentity · il riuso DICHIARA la sede che la persona ha già', () => {
  it('sede uguale a quella dichiarata: `scuolaIdEsistente` torna, e nessun allarme', async () => {
    stato.utenti = [PROFILO_STAFF]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('atteso ok')
    // Il campo c'è ANCHE quando le due sedi coincidono: un campo che compare solo
    // nel caso storto costringe il chiamante a distinguere «non diverge» da «non
    // l'ho letto», che sono due cose diverse.
    expect(r.scuolaIdEsistente).toBe(SEDE_A)
    expect(log('riuso-con-sede-diversa'), 'divergenza segnalata fra due sedi identiche').toBeFalsy()
    // E la riga del riuso porta comunque la sede: è ciò che la rende leggibile a
    // mesi di distanza senza andare a rileggere `utenti`.
    expect((log('identita-staff-riusata')![2] as { sede_id?: string }).sede_id).toBe(SEDE_A)
  })

  it('la persona è in un ALTRO plesso: `ok:true`, ma la sede vera torna al chiamante', async () => {
    // `input.scuolaId` è `SEDE_A` (la sede della pratica), il profilo esistente è
    // in `SEDE_B`. Nessuno dei due valori è sbagliato: è la segreteria a dover
    // decidere se quella maestra si è trasferita. Ma senza questo campo la route
    // non saprebbe nemmeno che c'è una decisione da prendere.
    stato.utenti = [{ ...PROFILO_STAFF, scuola_id: SEDE_B }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('atteso ok')
    expect(r.scuolaIdEsistente, 'torna la sede DICHIARATA dalla pratica invece di quella vera').toBe(SEDE_B)
    expect(r.scuolaIdEsistente).not.toBe(SEDE_A)
    nessunaScrittura()

    const diverso = log('riuso-con-sede-diversa')
    expect(diverso, 'la persona resta in un altro plesso e non lo registra nessuno').toBeTruthy()
    // `warn` perché deve arrivare in `app_log`: è l'unico modo di rispondere, a
    // mesi di distanza, a «quante approvazioni hanno lasciato la persona altrove?».
    expect(diverso![1]).toBe('warn')
    const ctx = diverso![2] as Record<string, unknown>
    // ENTRAMBI gli uuid: con uno solo la riga direbbe «divergono» senza dire fra
    // cosa, e la si dovrebbe incrociare a mano con `utenti`.
    expect(ctx.sede_id, 'la sede della persona non è nella riga').toBe(SEDE_B)
    expect(ctx.sede_dichiarata, 'la sede della pratica non è nella riga').toBe(SEDE_A)
  })

  it('sede letta anche dal ramo per UID', async () => {
    // Le due SELECT sono due, e una sola corretta avrebbe reso la dichiarazione
    // dipendente da come è scritta l'email — cioè da un motivo che nessuno
    // potrebbe indovinare guardando la pratica.
    stato.authUsers = [{ id: UID_STAFF, email: EMAIL }]
    stato.utenti = [{ ...PROFILO_STAFF, email: 'Maestra.Prova@Example.test', scuola_id: SEDE_B }]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r).toMatchObject({ ok: true, riusato: true, scuolaIdEsistente: SEDE_B })
    expect((log('riuso-con-sede-diversa')![2] as { tipo?: string }).tipo).toBe('uid')
  })

  it('`scuola_id` assente dalla riga: `null`, e NESSUNA divergenza inventata', async () => {
    // Sul DB E2E della CI una colonna può non esserci. «Non l'ho letta» non è «è
    // diversa»: chiamarla divergenza riempirebbe `app_log` di allarmi su un
    // ambiente non migrato, ed è il modo più rapido per far smettere di guardare
    // proprio la riga che un giorno conterà.
    const senzaSede: Riga = { ...PROFILO_STAFF }
    delete senzaSede.scuola_id
    stato.utenti = [senzaSede]
    const r = await chiama({ seEsisteRiusa: true })

    expect(r).toMatchObject({ ok: true, riusato: true, scuolaIdEsistente: null })
    expect(log('riuso-con-sede-diversa'), 'divergenza dichiarata su una sede mai letta').toBeFalsy()
  })
})
