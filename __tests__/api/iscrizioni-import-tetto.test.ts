import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL TETTO GIORNALIERO DELL'IMPORT ISCRIZIONI SI MISURA IN EMAIL, NON IN DOMANDE.
 *
 * Decisione del titolare, 2026-08-16: dal quel giorno ogni genitore con un indirizzo ha il
 * suo account, quindi una domanda con due genitori costa il DOPPIO di una con un genitore
 * solo. Un tetto espresso in domande sarebbe un numero che sembra un limite e non lo è.
 *
 * Da lì discendono le quattro invarianti che questo file blocca, e che sono tutte
 * conseguenze pratiche di quella scelta, non abbellimenti:
 *
 *  1. IL COSTO SI STIMA PRIMA. Una famiglia non si spacca a metà: se le email della domanda
 *     non ci stanno nel residuo, la domanda si rinvia INTERA. Cominciarla e fermarsi dopo il
 *     primo genitore è l'unico esito che non si può spiegare a nessuno — un genitore con
 *     l'accesso e l'altro no, senza che nessuno dei due sappia perché.
 *
 *  2. LA GUARDIA DELL'`emailOggi === 0`. È il contrappeso del punto 1: senza, una domanda che
 *     da sola costa più dell'intero tetto verrebbe rinviata ogni singolo giorno, per sempre,
 *     e nessun log direbbe che è proprio lei a non passare mai. La stima «prima» diventerebbe
 *     una prigione. Con tre genitori e un tetto abbassato a mano dalla segreteria è uno
 *     scenario raggiungibile, non teorico.
 *
 *  3. IL 429 NON È UN FALLIMENTO. «Il fornitore ha finito la quota» non è «questa domanda è
 *     sbagliata»: contarlo fra le fallite brucerebbe i tentativi di domande BUONE, e insistere
 *     sulla coda residua non farebbe che sprecarla. Ferma il giro e riprende domani.
 *
 *  4. IL BATTITO STA IN UN `finally`. È la stessa cecità che gli altri cron della famiglia
 *     hanno già chiuso: se il giro eccepisce a metà e nessuno scrive la riga di chiusura,
 *     chi sorveglia non distingue «il job non è mai partito» da «il job è partito ed è morto».
 *
 * E la prova a vuoto, che le tiene insieme: `dry_run` deve poter girare tutte le volte che si
 * vuole senza lasciare un segno — nessun claim, nessuna anagrafica, nessuna email, e nemmeno
 * la ripresa degli inviti sospesi. Un dry-run che consegna una password non è a vuoto.
 *
 * COME SI OSSERVA: il logger è muto sotto vitest, quindi lo si mocka e si asserisce sulle
 * CHIAMATE. Le righe del wrapper `withRoute` viaggiano su `evento: 'route'`: qui si guarda
 * solo `evento: 'cron'`, che è dove vivono i battiti che qualcuno sorveglia davvero.
 */

// ── Le spie sul logger ───────────────────────────────────────────────────────
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['iscrizione', 'cron']) }))

// ── Il finto Supabase: `from()` risolve per TABELLA, `rpc()` registra le chiamate ──
//
// Le rpc si registrano invece di essere simulate a fondo perché è ciò che i test chiedono:
// «`iscrizioni_prendi_in_carico` NON deve essere chiamata in prova a vuoto» e «la domanda
// rinviata deve finire in `in_attesa` con il motivo scritto in italiano» sono asserzioni
// sull'ESSERE STATA chiamata e sugli argomenti, non sull'esito.
const db = vi.hoisted(() => {
  const state = {
    /** Le sedi con un elenco attivo. */
    elenchi: [] as Array<Record<string, unknown>>,
    elenchiError: null as unknown,
    /** Le domande della sede, nella forma grezza di `enrollment_submissions`. */
    domande: [] as Array<Record<string, unknown>>,
    /** Gli id che `iscrizioni_prendi_in_carico` restituisce. */
    lotto: [] as string[],
    lottoError: null as unknown,
    rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  }
  function client(): unknown {
    return {
      from(table: string) {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'is', 'lt', 'lte', 'gte', 'update', 'delete']) {
          b[m] = () => b
        }
        const risolvi = (): { data: unknown; error: unknown } => {
          if (table === 'iscrizioni_elenco_caricamenti') return { data: state.elenchi, error: state.elenchiError }
          if (table === 'enrollment_submissions') return { data: state.domande, error: null }
          return { data: [], error: null }
        }
        b.maybeSingle = async () => risolvi()
        b.single = async () => risolvi()
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
        return b
      },
      rpc(nome: string, args: Record<string, unknown>) {
        state.rpc.push({ nome, args })
        const esito =
          nome === 'iscrizioni_prendi_in_carico'
            ? { data: state.lotto, error: state.lottoError }
            : { data: null, error: null }
        return { then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko) }
      },
    }
  }
  return { state, client }
})
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

// ── Le due letture di DB del lotto restano fuori dal mirino ──────────────────
// `caricaElenco` e `caricaDecisioni` interrogano tabelle che non c'entrano col tetto: si
// sostituiscono, e tutto il resto del modulo (`domandaDaRiga`, `costruisciFamiglie`,
// `trovaDuplicati`, `INVITI_AL_GIORNO`) resta QUELLO VERO — compreso il 300 di default, che
// se qualcuno lo cambiasse cambierebbe il significato di questi test.
const lotto = vi.hoisted(() => ({
  caricaElenco: vi.fn(async () => ({ righe: [{ id: 'r1', classe: 'Sezione A', nome: 'RIGA UNICA', riga: 2, retta: 180, rettaTesto: null }], caricatoIl: null })),
  caricaDecisioni: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/iscrizioni/import/lotto', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/lotto')>()
  return { ...vero, caricaElenco: lotto.caricaElenco, caricaDecisioni: lotto.caricaDecisioni }
})

// `decidi` è il ragionamento sull'abbinamento: qui interessa solo che dica «invia», perché
// il tetto si applica DOPO la decisione. Il resto di `analisi` resta vero (`preferibile` è
// usata da `trovaDuplicati`, che qui gira per davvero).
const analisi = vi.hoisted(() => ({
  decidi: vi.fn(() => ({ tipo: 'invia', assegnazioni: [], referente: { nome: 'Genitore', cognome: 'Inventato', email: null, codiceFiscale: null, ruolo: null } })),
}))
vi.mock('@/lib/iscrizioni/import/analisi', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/analisi')>()
  return { ...vero, decidi: analisi.decidi }
})

const esegui = vi.hoisted(() => ({ eseguiDomanda: vi.fn() }))
vi.mock('@/lib/iscrizioni/import/esegui', () => esegui)

// Il costo previsto, per default, è il numero di caselle DISTINTE della domanda: nessuno ha
// ancora ricevuto il suo invito. È la funzione vera in miniatura, e tenerla così rende
// leggibile ogni test («due genitori ⇒ due email»).
const inviti = vi.hoisted(() => ({
  invitiPrevisti: vi.fn(async (_c: unknown, email: readonly (string | null)[]) =>
    new Set(email.filter((e): e is string => typeof e === 'string' && e.includes('@'))).size),
  riprendiInvitiSospesi: vi.fn(async () => ({ spedite: 0, fallite: 0, rinviata: false })),
}))
vi.mock('@/lib/iscrizioni/import/inviti', () => inviti)

const mail = vi.hoisted(() => ({ sendEmailDetailed: vi.fn(async () => ({ ok: true, messageId: 'm-1' })) }))
vi.mock('@/lib/email/send', () => mail)
const contesto = vi.hoisted(() => ({ risolviContestoSede: vi.fn(async () => ({ email: 'segreteria@example.test', nome: 'Sede di prova' })) }))
vi.mock('@/lib/email/contesto', () => contesto)

// La finestra del calendario (22 ago – 10 set) non è l'oggetto di questi test: si fissa
// «oggi» dentro la finestra invece di passare `forza_fuori_finestra`, così il percorso
// esercitato è quello vero del cron e non quello del collaudo.
vi.mock('@/lib/format/fiscal-date', () => ({ oggiFiscaleISO: () => '2026-08-25', annoFiscale: () => 2026 }))

import { POST } from '@/app/api/iscrizione/import-massivo/route'

const SEGRETO = 'segreto-di-prova'
const SEDE = '11111111-1111-1111-1111-111111111111'

function req(corpo: unknown, secret?: string): Request {
  return new Request('http://localhost/api/iscrizione/import-massivo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-cron-secret': secret } : {}) },
    body: JSON.stringify(corpo),
  })
}

/** Una domanda inventata: nomi di fantasia e domini `.test`, il repo è pubblico. */
function domanda(id: string, email: string[]): Record<string, unknown> {
  return {
    id,
    scuola_id: SEDE,
    created_at: '2026-07-01T09:00:00Z',
    data: {
      children: [{ nome: 'Bambina', cognome: 'Inventata', data_nascita: '2022-04-05' }],
      adults: email.map((e, i) => ({
        first_name: i === 0 ? 'Genitore' : 'Altrogenitore',
        last_name: 'Inventato',
        email: e,
        ruolo: i === 0 ? 'madre' : 'padre',
      })),
    },
  }
}

function righe(livello?: string): Array<{ evento: string; livello: string; campi: Record<string, unknown> }> {
  return log.logEvento.mock.calls
    .filter((c) => livello === undefined || c[1] === livello)
    .map((c) => ({ evento: c[0] as string, livello: c[1] as string, campi: (c[2] ?? {}) as Record<string, unknown> }))
}
/** Il battito di chiusura del job: è QUESTA riga che chi sorveglia i cron cerca. */
/**
 * I battiti: le righe `cron` di fine giro, riuscite o no.
 *
 * ⚠️ NON si filtra su `esito === 'ok'`, ed è il punto. Il lock di famiglia
 * (`__tests__/api/cron-battito.test.ts`) riconosce un giro riuscito proprio così,
 * SENZA guardare il livello: finché un giro morto scriveva `esito:'ok'` a livello
 * `warn`, chiunque avesse copiato quella query l'avrebbe contato come riuscito.
 * Dal 2026-08-17 un giro esploso scrive `esito:'errore'` — il battito c'è lo
 * stesso (/api/health guarda l'operazione, non l'esito) ma non si traveste da
 * successo. Qui si raccolgono entrambi e sono le prove a dire quale si aspettano.
 */
function battiti(): Array<{ livello: string; campi: Record<string, unknown> }> {
  return righe().filter(
    (r) => r.evento === 'cron' && (r.campi.esito === 'ok' || r.campi.esito === 'errore'),
  )
}
function sospensioni(): Array<Record<string, unknown>> {
  return db.state.rpc.filter((c) => c.nome === 'iscrizioni_sospendi').map((c) => c.args)
}

beforeEach(() => {
  vi.clearAllMocks()
  db.state.elenchi = [{ scuola_id: SEDE }]
  db.state.elenchiError = null
  db.state.domande = []
  db.state.lotto = []
  db.state.lottoError = null
  db.state.rpc = []
  // `mockReset` e non solo `clearAllMocks`: quest'ultimo azzera le chiamate, non le
  // implementazioni — un `once` non consumato traboccherebbe nel test dopo.
  supa.createAdminClient.mockReset().mockImplementation(async () => db.client())
  supa.createClient.mockReset().mockImplementation(async () => db.client())
  lotto.caricaElenco.mockResolvedValue({ righe: [{ id: 'r1', classe: 'Sezione A', nome: 'RIGA UNICA', riga: 2, retta: 180, rettaTesto: null }], caricatoIl: null })
  lotto.caricaDecisioni.mockResolvedValue(new Map())
  analisi.decidi.mockReturnValue({ tipo: 'invia', assegnazioni: [], referente: { nome: 'Genitore', cognome: 'Inventato', email: null, codiceFiscale: null, ruolo: null } })
  inviti.riprendiInvitiSospesi.mockResolvedValue({ spedite: 0, fallite: 0, rinviata: false })
  inviti.invitiPrevisti.mockImplementation(async (_c: unknown, email: readonly (string | null)[]) =>
    new Set(email.filter((e): e is string => typeof e === 'string' && e.includes('@'))).size)
  esegui.eseguiDomanda.mockResolvedValue({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })
  mail.sendEmailDetailed.mockResolvedValue({ ok: true, messageId: 'm-1' })
  vi.stubEnv('CRON_SECRET', SEGRETO)
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — il gate x-cron-secret', () => {
  it('POST anonimo: 401, e nessuna riga d\'errore fabbricata da un curl', async () => {
    const res = await POST(req({}))

    expect(res.status).toBe(401)
    // La route è pubblica e senza rate-limit: se gridasse anche sull'anonimo, un bot che
    // bussa diecimila volte produrrebbe dal nulla il segnale «il cron è rotto».
    expect(righe('error').filter((r) => r.evento === 'cron')).toHaveLength(0)
    // E il giro non è nemmeno cominciato: nessun client, nessuna domanda toccata.
    expect(supa.createAdminClient).not.toHaveBeenCalled()
  })

  it('segreto sbagliato: 401, e la riga d\'errore CI DEVE essere (un cron con la chiave vecchia è invisibile)', async () => {
    const res = await POST(req({}, 'chiave-sbagliata'))

    expect(res.status).toBe(401)
    expect(righe('error').some((r) => r.evento === 'cron' && r.campi.esito === 'secret-errato')).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — il tetto è in EMAIL, e una famiglia non si spacca a metà', () => {
  it('tetto 1, un\'email già uscita: la domanda da 2 email si rinvia INTERA, senza cominciarla', async () => {
    // Lo scenario che dà il nome a tutto: la ripresa di stamattina ha già speso l'unica
    // email disponibile, e la domanda che segue ne vuole due. Contando le DOMANDE, questa
    // sarebbe partita e avrebbe consegnato l'accesso a un genitore solo.
    inviti.riprendiInvitiSospesi.mockResolvedValue({ spedite: 1, fallite: 0, rinviata: false })
    db.state.lotto = ['d1']
    db.state.domande = [domanda('d1', ['genitore.uno@example.test', 'genitore.due@example.test'])]

    const res = await POST(req({ max_inviti: 1 }, SEGRETO))
    const corpo = await res.json()

    expect(res.status).toBe(200)
    // LA RIGA CHE CONTA: la domanda non è mai stata cominciata. Nessuna anagrafica scritta,
    // nessun account creato, nessuna password consegnata a metà famiglia.
    expect(esegui.eseguiDomanda).not.toHaveBeenCalled()
    expect(corpo.inviate).toBe(0)
    expect(corpo.restanoPerDomani).toBe(1)
    // Il costo si è stimato PRIMA: `invitiPrevisti` sulle caselle della domanda.
    expect(inviti.invitiPrevisti).toHaveBeenCalledTimes(1)

    // E resta in coda in modo esplicito, col motivo scritto in italiano: una domanda che
    // sparisce senza spiegazione è una segreteria che apre un ticket.
    const attesa = sospensioni().filter((a) => a.p_stato === 'in_attesa')
    expect(attesa).toHaveLength(1)
    expect(attesa[0].p_submission_id).toBe('d1')
    expect(String(attesa[0].p_motivo)).toContain('sarebbero servite 2 email')
    expect(String(attesa[0].p_motivo)).toContain('tetto di 1')
  })

  it('due caselle uguali contano UNA email: il tetto misura le caselle, non i genitori', async () => {
    // Undici domande vere portano la stessa casella per entrambi i genitori: lì l'account
    // resta uno solo. Se il tetto contasse le teste, quelle famiglie verrebbero rinviate
    // per una spesa che non esiste.
    inviti.riprendiInvitiSospesi.mockResolvedValue({ spedite: 1, fallite: 0, rinviata: false })
    db.state.lotto = ['d1']
    db.state.domande = [domanda('d1', ['casella.condivisa@example.test', 'casella.condivisa@example.test'])]
    esegui.eseguiDomanda.mockResolvedValue({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })

    const res = await POST(req({ max_inviti: 2 }, SEGRETO))
    const corpo = await res.json()

    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(corpo.inviate).toBe(1)
    expect(corpo.restanoPerDomani).toBe(0)
    // 1 dalla ripresa + 1 dalla domanda: la casella condivisa è costata una email sola.
    expect(corpo.emailSpedite).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — LA GUARDIA: a giro vuoto si parte comunque', () => {
  it('tetto 1 e domanda da 2 email come PRIMA del giro: si esegue lo stesso', async () => {
    // Senza questa guardia la domanda più cara del tetto non partirebbe MAI: rinviata oggi,
    // rinviata domani, rinviata sempre — e il solo log sarebbe un «restano: 1» che nessuno
    // collega a una famiglia precisa. Sforare di una email una volta sola è il male minore,
    // e per costruzione può capitare al massimo una volta per giro.
    db.state.lotto = ['d1']
    db.state.domande = [domanda('d1', ['genitore.uno@example.test', 'genitore.due@example.test'])]
    esegui.eseguiDomanda.mockResolvedValue({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 2 })

    const res = await POST(req({ max_inviti: 1 }, SEGRETO))
    const corpo = await res.json()

    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(corpo.inviate).toBe(1)
    expect(corpo.restanoPerDomani).toBe(0)
    expect(corpo.emailSpedite).toBe(2)
    // Nessuna sospensione: la domanda è passata, non è stata «tollerata e rimessa in coda».
    expect(sospensioni()).toHaveLength(0)
  })

  it('la guardia vale UNA volta: la domanda dopo, a tetto già sforato, viene rinviata', async () => {
    // Il contro-test: se la guardia guardasse qualcosa di diverso da `emailOggi === 0`
    // diventerebbe un permesso permanente, e il tetto non esisterebbe più.
    db.state.lotto = ['d1', 'd2']
    db.state.domande = [
      domanda('d1', ['prima.uno@example.test', 'prima.due@example.test']),
      domanda('d2', ['seconda@example.test']),
    ]
    esegui.eseguiDomanda.mockResolvedValue({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 2 })

    const res = await POST(req({ max_inviti: 1 }, SEGRETO))
    const corpo = await res.json()

    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(corpo.inviate).toBe(1)
    expect(corpo.restanoPerDomani).toBe(1)
    expect(sospensioni().filter((a) => a.p_submission_id === 'd2' && a.p_stato === 'in_attesa')).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — la prova a vuoto non lascia il segno', () => {
  it('dry_run: nessun claim, nessuna esecuzione, nessuna email, e nemmeno la ripresa', async () => {
    db.state.domande = [domanda('d1', ['genitore.uno@example.test', 'genitore.due@example.test'])]

    const res = await POST(req({ dry_run: true }, SEGRETO))
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.dryRun).toBe(true)
    // Il lotto NON si prende in carico: un dry-run che mette in prestito trecento domande
    // per trenta minuti impedisce al giro vero di lavorarle.
    expect(db.state.rpc.filter((c) => c.nome === 'iscrizioni_prendi_in_carico')).toHaveLength(0)
    // Nessuna scrittura di stato, nemmeno le sospensioni «da controllare»/«duplicata».
    expect(db.state.rpc).toHaveLength(0)
    expect(esegui.eseguiDomanda).not.toHaveBeenCalled()
    expect(mail.sendEmailDetailed).not.toHaveBeenCalled()
    // La ripresa è la trappola meno ovvia: manda credenziali VERE a chi era rimasto
    // indietro, e non ha niente a che vedere con le domande che il dry-run sta esaminando.
    expect(inviti.riprendiInvitiSospesi).not.toHaveBeenCalled()

    // …e però i numeri li dà lo stesso, altrimenti non servirebbe a niente: due caselle,
    // due email, una domanda che sarebbe partita.
    expect(corpo.inviate).toBe(1)
    expect(corpo.emailSpedite).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — il 429 è «non oggi», non «non si può»', () => {
  it('esito «rinviata»: ferma il giro, non conta come fallimento, e la domanda non è fra le bloccate', async () => {
    db.state.lotto = ['d1', 'd2']
    db.state.domande = [
      domanda('d1', ['prima@example.test']),
      domanda('d2', ['seconda@example.test']),
    ]
    esegui.eseguiDomanda.mockResolvedValue({ esito: 'rinviata', messageId: null, errore: 'quota esaurita', emailSpedite: 0 })

    const res = await POST(req({}, SEGRETO))
    const corpo = await res.json()

    expect(res.status).toBe(200)
    expect(corpo.quotaEsaurita).toBe(true)
    // Non è un fallimento: contarlo brucerebbe i tentativi di una domanda BUONA e la
    // porterebbe a `bloccata` — cioè si perderebbe un'iscrizione valida per un limite di quota.
    expect(corpo.fallite).toBe(0)
    expect(corpo.bloccate).toBe(0)
    expect(corpo.restanoPerDomani).toBe(1)
    // E il giro si ferma davvero: la seconda domanda non viene nemmeno tentata, perché un
    // 429 non si risolve al messaggio dopo e insistere brucerebbe tutta la coda residua.
    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — il battito sta in un `finally`', () => {
  it('giro sano: battito «ok» a livello info', async () => {
    db.state.lotto = ['d1']
    db.state.domande = [domanda('d1', ['genitore.uno@example.test'])]

    const res = await POST(req({}, SEGRETO))

    expect(res.status).toBe(200)
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].livello).toBe('info')
    expect(battiti()[0].campi.esito).toBe('ok')
    expect(battiti()[0].campi.n).toBe(1)
  })

  it('IL POST ANONIMO NON SCRIVE NIENTE: nessun battito, nessuna riga in app_log', async () => {
    // Questa porta è pubblica e senza tetto di frequenza. Finché il `finally`
    // girava anche sul ramo 401, un bot che bussa diecimila volte scriveva
    // diecimila righe in `app_log` di produzione — per giunta con la frase
    // «concluso con errore» addosso a un gate che aveva funzionato benissimo.
    const res = await POST(req({}, 'segreto-sbagliato-ma-presente'))
    expect(res.status).toBe(401)
    expect(battiti()).toHaveLength(0)
  })

  it('eccezione A METÀ GIRO: 500, ma il battito c\'è lo stesso — e porta il lavoro già fatto', async () => {
    // La prima domanda parte, la seconda fa esplodere il giro. Senza il `finally`,
    // /api/health conterebbe muto un job che INVECE ha girato e ha pure spedito: «nessun
    // log» significherebbe insieme «non è mai partito» e «è partito ed è morto», che sono
    // due guasti diversi con due rimedi diversi.
    db.state.lotto = ['d1', 'd2']
    db.state.domande = [
      domanda('d1', ['prima@example.test']),
      domanda('d2', ['seconda@example.test']),
    ]
    const guasto = new Error('anagrafica non scritta')
    esegui.eseguiDomanda
      .mockResolvedValueOnce({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })
      .mockRejectedValueOnce(guasto)

    const res = await POST(req({}, SEGRETO))

    expect(res.status).toBe(500)
    expect(battiti()).toHaveLength(1)
    // Un giro morto NON si traveste da riuscito: l'esito cambia, non solo il livello.
    // Il contatore riporta il lavoro fatto prima di morire — una domanda È partita, e
    // domani non va rifatta.
    expect(battiti()[0].campi.esito).toBe('errore')
    expect(battiti()[0].livello).toBe('warn')
    expect(battiti()[0].campi.n).toBe(1)
    expect(String(battiti()[0].campi.msg)).toContain('concluso con errore')
    // Il corpo dell'errore non si butta via: l'errore vero viaggia nel 2° argomento.
    expect(log.logErrore).toHaveBeenCalledTimes(1)
    const [campi, err] = log.logErrore.mock.calls[0] as [Record<string, unknown>, unknown]
    expect(campi).toMatchObject({ evento: 'cron', stato: 500 })
    expect(err).toBe(guasto)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// IL TEMPO, CHE DAL 2026-08-20 FERMA IL GIRO PRIMA DEL TETTO
//
// Con il tetto a 90 email nessun orologio si riempiva. Con 300 sì: misurato in
// produzione il 2026-08-20 sull'inoltro arretrato delle candidature, che spedisce
// senza pause, 50 email hanno preso 57,2 secondi — e quel giro è più leggero di
// questo. Senza la guardia, la funzione verrebbe troncata a metà di una domanda:
// un genitore con l'accesso e l'altro no, e nessun log a dirlo.
// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — il giro si chiude da sé quando il tempo finisce', () => {
  it('si ferma prima di cominciare una domanda che sforerebbe, e NON la sospende', async () => {
    db.state.domande = ['d1', 'd2', 'd3', 'd4'].map((id) => domanda(id, [`${id}@example.test`]))
    db.state.lotto = ['d1', 'd2', 'd3', 'd4']

    // Ogni domanda «costa» 100 secondi di orologio: alla terza il budget di 240 s
    // è finito. `eseguiDomanda` è già finta, quindi si sposta solo il tempo.
    const vero = Date.now
    let trascorso = 0
    vi.spyOn(Date, 'now').mockImplementation(() => vero.call(Date) + trascorso)
    esegui.eseguiDomanda.mockImplementation(async () => {
      trascorso += 100_000
      return { esito: 'inviata', messageId: 'm', errore: null, emailSpedite: 1 }
    })

    const res = await POST(req({ max_inviti: 500 }, SEGRETO))
    const corpo = await res.json()

    // Tre lavorate (0 s, 100 s, 200 s), la quarta no: a 300 s il budget è sforato.
    expect(corpo.inviate).toBe(3)
    expect(corpo.tempoScaduto).toBe(true)
    expect(corpo.nonLavorate).toBe(1)
    // Le non lavorate NON si sospendono: il prestito di 30 minuti le libera da sé,
    // e scrivere «rinviata» su ognuna costerebbe altro tempo di funzione.
    expect(sospensioni()).toHaveLength(0)
    vi.mocked(Date.now).mockRestore()
  })

  it('«fermato dal tempo» e «fermato dalla quota» non si confondono nei log', async () => {
    db.state.domande = ['d1', 'd2'].map((id) => domanda(id, [`${id}@example.test`]))
    db.state.lotto = ['d1', 'd2']

    const vero = Date.now
    let trascorso = 0
    vi.spyOn(Date, 'now').mockImplementation(() => vero.call(Date) + trascorso)
    esegui.eseguiDomanda.mockImplementation(async () => {
      trascorso += 250_000
      return { esito: 'inviata', messageId: 'm', errore: null, emailSpedite: 1 }
    })

    await POST(req({ max_inviti: 500 }, SEGRETO))

    const perTempo = righe().filter((r) => r.evento === 'cron' && r.campi.esito === 'tempo-scaduto')
    expect(perTempo).toHaveLength(1)
    expect(perTempo[0].livello).toBe('warn')
    // I due rimedi sono opposti — più giri contro più quota — e con lo stesso
    // `esito` chi legge i log fra un mese non potrebbe più separarli.
    expect(String(perTempo[0].campi.msg)).toMatch(/non dalla quota/)
    // Il battito di famiglia resta `ok`: il giro è girato, e /api/health lo cerca.
    expect(battiti().some((b) => b.campi.esito === 'ok')).toBe(true)
    vi.mocked(Date.now).mockRestore()
  })

  it('un giro che sta nel tempo non dichiara niente', async () => {
    db.state.domande = [domanda('d1', ['d1@example.test'])]
    db.state.lotto = ['d1']

    const res = await POST(req({}, SEGRETO))
    const corpo = await res.json()

    expect(corpo.tempoScaduto).toBe(false)
    expect(corpo.nonLavorate).toBe(0)
    expect(righe().filter((r) => r.campi.esito === 'tempo-scaduto')).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('import iscrizioni — l\'ordine delle sedi non lo decide il database', () => {
  it('le sedi si lavorano in un ordine stabile, qualunque cosa risponda PostgREST', async () => {
    const A = '11111111-1111-1111-1111-111111111111'
    const B = '22222222-2222-2222-2222-222222222222'
    const C = '33333333-3333-3333-3333-333333333333'
    // Il database le restituisce in disordine, come fa quando non c'è un `order`.
    db.state.elenchi = [{ scuola_id: C }, { scuola_id: A }, { scuola_id: B }]
    db.state.domande = []
    db.state.lotto = []

    await POST(req({}, SEGRETO))

    // Il finto di `caricaElenco` è dichiarato senza argomenti: qui interessa il
    // SECONDO, che è la sede. Si passa da `unknown[]` invece di forzare il tipo.
    const chiamate = (lotto.caricaElenco.mock.calls as unknown as unknown[][]).map((c) => c[1] as string)
    expect(chiamate).toEqual([A, B, C])
  })
})
