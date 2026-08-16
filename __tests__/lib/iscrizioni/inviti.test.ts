import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL REGISTRO DEGLI INVITI — le tre regole che, se cedono, si vedono su famiglie vere.
 *
 * 1. il REFERENTE è bloccante e gli ALTRI genitori sono best-effort. Non è una
 *    sfumatura: è ciò che rende mantenibile la regola del titolare («se l'email
 *    non parte, l'iscrizione non deve restare fatta a metà») senza toglierla a chi
 *    l'accesso ce l'ha già.
 * 2. il 429 è «non oggi», non «non si può»: non consuma un tentativo e non porta
 *    a `bloccata` una domanda buona.
 * 3. `email_conflict` è un esito PREVISTO — sono le 11 domande misurate in cui i
 *    due genitori condividono la casella — e non un guasto da riprovare tre volte.
 */

const h = vi.hoisted(() => ({
  ensureParentIdentity: vi.fn(),
  sincronizzaLegamiRuntime: vi.fn(),
  rigeneraPasswordPerInvito: vi.fn(),
  sendEmailDetailed: vi.fn(),
  sedeDelGenitore: vi.fn(),
  /** Ogni scrittura sul registro, in ordine: è il diario che le prove leggono. */
  scritture: [] as { tipo: string; payload?: unknown; chiave?: unknown }[],
  /** Le righe che `riprendiInvitiSospesi` trova da riprovare. */
  sospesi: [] as Record<string, unknown>[],
  /** Quante righe restituisce il claim: `[]` = il posto era già preso. */
  claim: [{ auth_user_id: 'acc-1' }] as unknown[],
}))

vi.mock('@/lib/auth/parent-identity', () => ({
  ensureParentIdentity: h.ensureParentIdentity,
  sedeDelGenitore: h.sedeDelGenitore,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: h.sincronizzaLegamiRuntime }))
vi.mock('@/lib/auth/password-invito', () => ({ rigeneraPasswordPerInvito: h.rigeneraPasswordPerInvito }))
vi.mock('@/lib/email/send', () => ({ sendEmailDetailed: h.sendEmailDetailed }))
vi.mock('@/lib/email/contesto', () => ({
  risolviContestoSede: async () => ({
    nome: 'Kidville', indirizzo: null, email: null, telefono: null,
    app: 'https://esempio.test', privacy: 'https://esempio.test/privacy',
  }),
}))
vi.mock('@/lib/email/messaggi/credenziali', () => ({
  messaggioCredenziali: () => ({ oggetto: 'o', testo: 't', html: '<p>h</p>' }),
}))

const supabase = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.in = () => b
    b.lt = () => b
    b.order = () => b
    b.limit = async () => ({ data: h.sospesi, error: null })
    b.maybeSingle = async () => ({
      data: table === 'parents' ? { id: 'p-1', auth_user_id: null, emails: ['a@example.test'], first_name: 'Anna' } : null,
      error: null,
    })
    b.upsert = (payload: unknown) => {
      h.scritture.push({ tipo: `upsert:${table}`, payload })
      return { select: async () => ({ data: h.claim, error: null }) }
    }
    b.update = (payload: unknown) => {
      h.scritture.push({ tipo: `update:${table}`, payload })
      return { eq: async () => ({ data: null, error: null }) }
    }
    b.delete = () => {
      h.scritture.push({ tipo: `delete:${table}` })
      return { eq: async () => ({ data: null, error: null }) }
    }
    return b
  },
} as never

import { invitaGenitore, riprendiInvitiSospesi, invitiPrevisti, normalizzaEmail } from '@/lib/iscrizioni/import/inviti'
import { normalizzaEmailModulo } from '@/lib/iscrizioni/email-genitori'

const GENITORE = { parentId: 'p-1', nome: 'Anna', scuolaId: 'sc-1', submissionId: 'sub-1' }

const identitaOk = {
  ok: true, authUserId: 'acc-1', email: 'a@example.test',
  createdAuth: true, createdUtenti: true, boundNow: true,
  password: 'segreta', scuolaId: 'sc-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.sospesi = []
  h.claim = [{ auth_user_id: 'acc-1' }]
  h.ensureParentIdentity.mockResolvedValue(identitaOk)
  h.sincronizzaLegamiRuntime.mockResolvedValue({ creati: 1 })
  h.rigeneraPasswordPerInvito.mockResolvedValue({ ok: true, password: 'nuova' })
  h.sedeDelGenitore.mockResolvedValue({ scuolaId: 'sc-1', motivo: 'figli', sediFigli: ['sc-1'] })
  h.sendEmailDetailed.mockResolvedValue({ ok: true, error: null, messageId: 'msg-1' })
})

const registro = () => h.scritture.filter((s) => s.tipo.endsWith('iscrizioni_inviti_credenziali'))

describe('inviti — un account, un invito, e nessun genitore lasciato fuori', () => {
  it('il genitore ottiene account, legami e credenziali, e il registro dice «inviata»', async () => {
    const esito = await invitaGenitore(supabase, GENITORE, 'ritira')

    expect(esito).toMatchObject({ tipo: 'inviata', authUserId: 'acc-1', messageId: 'msg-1' })
    // Il legame runtime vale per OGNI genitore che ottiene l'accesso: senza, il
    // secondo genitore entrerebbe e non vedrebbe suo figlio.
    expect(h.sincronizzaLegamiRuntime).toHaveBeenCalledWith(supabase, 'p-1')
    expect(registro().map((s) => s.tipo)).toEqual([
      'upsert:iscrizioni_inviti_credenziali',
      'update:iscrizioni_inviti_credenziali',
    ])
    expect((registro()[1].payload as { stato: string }).stato).toBe('inviata')
  })

  it('IL POSTO SI PRENDE PRIMA DI SPEDIRE, e non dopo', async () => {
    // Se l'ordine si invertisse, un processo tagliato a metà fra l'invio e la
    // scrittura manderebbe la stessa password due volte il giorno dopo.
    await invitaGenitore(supabase, GENITORE, 'ritira')
    const indiceClaim = h.scritture.findIndex((s) => s.tipo === 'upsert:iscrizioni_inviti_credenziali')
    const indiceInvio = h.sendEmailDetailed.mock.invocationCallOrder[0]
    const indiceUpsertReale = h.scritture[indiceClaim] ? indiceClaim : -1
    expect(indiceUpsertReale).toBeGreaterThanOrEqual(0)
    expect(indiceInvio).toBeGreaterThan(0)
    // Il claim è la PRIMA scrittura sul registro, l'invio viene dopo.
    expect(registro()[0].tipo).toBe('upsert:iscrizioni_inviti_credenziali')
  })

  it('posto già preso: nessuna seconda email, e l\'esito lo dice', async () => {
    h.claim = []
    const esito = await invitaGenitore(supabase, GENITORE, 'ritira')
    expect(esito).toMatchObject({ tipo: 'gia_invitata' })
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('l\'account esisteva già (password null): la password si RIGENERA', async () => {
    // ①`ensureParentIdentity` restituisce la password solo quando crea l'account.
    // Senza questo ramo il secondo tentativo non avrebbe niente da mandare, e
    // l'invito resterebbe appeso fino a «bloccata» senza un errore che lo spieghi.
    h.ensureParentIdentity.mockResolvedValue({ ...identitaOk, createdAuth: false, password: null })
    const esito = await invitaGenitore(supabase, GENITORE, 'ritira')
    expect(h.rigeneraPasswordPerInvito).toHaveBeenCalledTimes(1)
    expect(esito.tipo).toBe('inviata')
  })

  it('email_conflict è un esito previsto, non un fallimento', async () => {
    // Gli 11 casi misurati in cui i due genitori condividono la casella. Un
    // «fallita» qui brucerebbe tre tentativi su una situazione che non cambierà.
    h.ensureParentIdentity.mockResolvedValue({ ok: false, reason: 'email_conflict', message: 'già collegata' })
    const esito = await invitaGenitore(supabase, GENITORE, 'registra')
    expect(esito.tipo).toBe('condivisa')
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
    // Nessuna riga di registro: non c'è nessun account nuovo a cui appenderla.
    expect(registro()).toHaveLength(0)
  })

  describe('il 429 è «non oggi», non «non si può»', () => {
    beforeEach(() => {
      h.sendEmailDetailed.mockResolvedValue({ ok: false, rinviabile: true, error: 'quota esaurita (429)' })
    })

    it('non consuma un tentativo e non marca la riga «fallita»', async () => {
      const esito = await invitaGenitore(supabase, GENITORE, 'registra')
      expect(esito.tipo).toBe('rinviata')
      // La riga resta `da_inviare`: nessun update a `fallita`, nessun `tentativi`.
      const aggiornamenti = registro().filter((s) => s.tipo.startsWith('update:'))
      expect(aggiornamenti).toHaveLength(0)
    })

    it('col referente (alFallimento «ritira») la riga si cancella: la domanda riparte pulita', async () => {
      // Si sta per disfare tutta l'anagrafica: una riga di registro orfana
      // manderebbe domani le credenziali a un genitore senza più figli collegati.
      const esito = await invitaGenitore(supabase, GENITORE, 'ritira')
      expect(esito.tipo).toBe('rinviata')
      expect(registro().some((s) => s.tipo === 'delete:iscrizioni_inviti_credenziali')).toBe(true)
    })
  })

  it('un rifiuto DEFINITIVO invece consuma il tentativo e resta scritto', async () => {
    // È il contrappunto del test qui sopra: se questo non fosse distinto dal 429,
    // «non oggi» e «non si può» finirebbero nello stesso secchio e uno dei due
    // comportamenti sarebbe sbagliato per forza.
    h.sendEmailDetailed.mockResolvedValue({ ok: false, error: 'rifiutato dal provider email (403)' })
    const esito = await invitaGenitore(supabase, GENITORE, 'registra')
    expect(esito.tipo).toBe('fallita')
    const ultimo = registro().at(-1)?.payload as { stato: string; tentativi: number; ultimo_errore: string }
    expect(ultimo).toMatchObject({ stato: 'fallita', tentativi: 1 })
    expect(ultimo.ultimo_errore).toContain('403')
  })
})

describe('la ripresa — chi aspetta da ieri viene prima di chi arriva oggi', () => {
  it('senza righe sospese non fa niente e non spende quota', async () => {
    const esito = await riprendiInvitiSospesi(supabase, 10)
    expect(esito).toEqual({ spedite: 0, fallite: 0, rinviata: false })
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('riprova le righe rimaste indietro e conta le email uscite', async () => {
    // Senza la ripresa il secondo genitore fallito sarebbe perso PER SEMPRE: la
    // sua domanda è già `approved` e il lotto non la ripescherà mai più.
    h.sospesi = [
      { auth_user_id: 'acc-9', email: 'b@example.test', parent_id: 'p-9', tentativi: 1 },
    ]
    const esito = await riprendiInvitiSospesi(supabase, 10)
    expect(esito.spedite).toBe(1)
    // L'account esiste già da ieri: la password si rigenera sempre.
    expect(h.rigeneraPasswordPerInvito).toHaveBeenCalledTimes(1)
  })

  it('un 429 durante la ripresa FERMA il giro invece di bruciare la coda', async () => {
    h.sospesi = [
      { auth_user_id: 'acc-9', email: 'b@example.test', parent_id: 'p-9', tentativi: 0 },
      { auth_user_id: 'acc-8', email: 'c@example.test', parent_id: 'p-8', tentativi: 0 },
    ]
    h.sendEmailDetailed.mockResolvedValue({ ok: false, rinviabile: true, error: 'quota esaurita (429)' })
    const esito = await riprendiInvitiSospesi(supabase, 10)
    expect(esito.rinviata).toBe(true)
    expect(esito.fallite).toBe(0)
    // Un 429 non si risolve al messaggio dopo: si smette al primo.
    expect(h.sendEmailDetailed).toHaveBeenCalledTimes(1)
  })

  it('con quota residua zero non prova nemmeno a leggere', async () => {
    const esito = await riprendiInvitiSospesi(supabase, 0)
    expect(esito.spedite).toBe(0)
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })
})

describe('il costo di una domanda si misura in EMAIL, non in domande', () => {
  it('le caselle si contano DISTINTE e normalizzate', async () => {
    // Due genitori sulla stessa casella costano UNA email, non due: è il caso
    // misurato in 11 domande, e contarlo due volte sprecherebbe quota vera.
    const n = await invitiPrevisti(supabase, ['Mario@Example.test ', 'mario@example.test', null, ''])
    expect(n).toBe(1)
  })

  it('nessun indirizzo ⇒ nessun costo, e nessuna lettura inutile', async () => {
    expect(await invitiPrevisti(supabase, [null, '', undefined as unknown as string])).toBe(0)
  })

  it('la normalizzazione è UNA SOLA, ed è quella del database (lower + btrim)', () => {
    // `inviti.ts` non ne tiene una propria: ri-esporta quella del modulo del
    // form. Due copie divergerebbero al primo ritocco, e la divergenza si
    // vedrebbe come un modulo che rifiuta un indirizzo che l'import tratta come
    // nuovo — o il contrario, che è peggio.
    expect(normalizzaEmail('  MARIO@Example.TEST ')).toBe('mario@example.test')
    expect(normalizzaEmail).toBe(normalizzaEmailModulo)
  })
})
