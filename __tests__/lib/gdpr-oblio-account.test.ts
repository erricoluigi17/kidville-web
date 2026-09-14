import { describe, it, expect, vi, beforeEach } from 'vitest'
import { anonimizzaParent } from '@/lib/gdpr/esegui'
import { contaAccountOblio } from '@/lib/gdpr/account-oblio'

// Le spie servono a dimostrare che OGNI ramo lascia la sua riga, successo compreso,
// e che dentro non finisce né un'email né un nome. Il resto del modulo resta vero.
const spie = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: spie.logEvento, logErrore: spie.logErrore }
})

// =============================================================================
// L'OBLIO DI UN GENITORE LIBERA ANCHE IL SUO ACCOUNT.
//
// IL FATTO (2026-09-02, produzione). Un oblio ha anonimizzato una scheda `parents`
// — nome a `CANCELLATO-…`, `auth_user_id` a NULL, domanda d'iscrizione svuotata —
// e non ha toccato `utenti` né `auth.users`: sono sopravvissuti l'email, il nome,
// `ruolo = 'genitore'` e il legame in `legame_genitori_alunni` verso il bambino
// già anonimizzato. Due danni:
//  1. l'«oblio» ha lasciato l'identità della persona;
//  2. quella stessa email era di una dipendente, e l'approvazione della sua pratica
//     del personale rispondeva 409 `email_gia_genitore`, perché trovava in `utenti`
//     un «genitore» con quell'indirizzo.
//
// COME SI PROVA QUI. Il finto client è un piccolo database in memoria che onora i
// filtri (`eq`/`neq`/`in`/`is`) e le chiavi esterne che contano: la FK NO ACTION
// di `legame_genitori_alunni.genitore_id` fa FALLIRE la cancellazione finché un
// legame è in piedi, e la cancellazione riuscita porta via in cascata la riga
// `utenti`. Senza queste due regole un test sull'ordine «prima i legami, poi
// l'account» sarebbe verde con e senza la correzione.
//
// Tutti i valori sono inventati: il repository è pubblico.
// =============================================================================

const AT = '2026-09-14T09:00:00Z'
const PARENT = '0b1c2d3e-0000-4000-8000-000000000001'
const ALTRA_SCHEDA = '0b1c2d3e-0000-4000-8000-000000000002'
const ACCOUNT = '0b1c2d3e-0000-4000-8000-0000000000a1'
const FIGLIO_ANONIMIZZATO = '0b1c2d3e-0000-4000-8000-0000000000c1'
const FIGLIO_VIVO = '0b1c2d3e-0000-4000-8000-0000000000c2'
const EMAIL = 'genitore.di.prova@example.invalid'
const NOME = 'NomeDiProva'
const COGNOME = 'CognomeDiProva'
const EMAIL_ANONIMA = `oblio-${ACCOUNT}@invalid.invalid`

type Riga = Record<string, unknown>
type Operazione = 'select' | 'update' | 'delete'
interface ErrorePostgrest { code: string; message: string }
interface ErroreAuth { name: string; message: string; status: number; code: string }

/** Ciò che risponde GoTrue quando Postgres rifiuta la cascata (FK NO ACTION verso `utenti`). */
const ERRORE_CASCATA: ErroreAuth = {
  name: 'AuthApiError',
  message: 'Database error deleting user',
  status: 500,
  code: 'unexpected_failure',
}
const ERRORE_AGGIORNAMENTO: ErroreAuth = {
  name: 'AuthApiError',
  message: 'Unable to validate email address: invalid format',
  status: 400,
  code: 'email_address_invalid',
}

interface CfgMondo {
  tabelle: Record<string, Riga[]>
  /** Errori PostgREST per `tabella:operazione`: PostgREST non lancia, li RESTITUISCE. */
  errori?: Record<string, ErrorePostgrest>
  /** Forza il rifiuto della cancellazione anche senza legami (es. `firme_documenti`). */
  cancellazioneRifiutata?: boolean
  erroreAggiornamentoAuth?: ErroreAuth | null
  /** I metadati che GoTrue conserva sull'account. */
  metadati?: Record<string, unknown>
}

function creaMondo(cfg: CfgMondo) {
  const tabelle: Record<string, Riga[]> = Object.fromEntries(
    Object.entries(cfg.tabelle).map(([t, righe]) => [t, righe.map((r) => ({ ...r }))]),
  )
  const scritture: { tabella: string; operazione: Operazione; patch?: Riga; n: number }[] = []
  /** L'ordine delle operazioni che contano, per le prove sull'ordine. */
  const cronologia: string[] = []

  const deleteUser = vi.fn(async (id: string) => {
    cronologia.push('auth:deleteUser')
    const legamiInPiedi = (tabelle.legame_genitori_alunni ?? []).some((l) => l.genitore_id === id)
    if (cfg.cancellazioneRifiutata || legamiInPiedi) {
      return { data: { user: null }, error: ERRORE_CASCATA }
    }
    // ON DELETE CASCADE su `utenti.id`, ON DELETE SET NULL su `parents.auth_user_id`.
    tabelle.utenti = (tabelle.utenti ?? []).filter((u) => u.id !== id)
    for (const p of tabelle.parents ?? []) if (p.auth_user_id === id) p.auth_user_id = null
    return { data: { user: null }, error: null }
  })
  const getUserById = vi.fn(async (id: string) => ({
    data: { user: { id, email: EMAIL, user_metadata: { ...(cfg.metadati ?? {}) } } },
    error: null,
  }))
  const updateUserById = vi.fn(async (id: string, attributi: Record<string, unknown>) => {
    cronologia.push('auth:updateUserById')
    if (cfg.erroreAggiornamentoAuth) return { data: { user: null }, error: cfg.erroreAggiornamentoAuth }
    return { data: { user: { id, ...attributi } }, error: null }
  })

  const client = {
    from(tabella: string) {
      const filtri: ((r: Riga) => boolean)[] = []
      let operazione: Operazione = 'select'
      let patch: Riga | undefined
      const esegui = (): { data: Riga[] | null; error: ErrorePostgrest | null } => {
        const errore = cfg.errori?.[`${tabella}:${operazione}`]
        if (errore) return { data: null, error: errore }
        const tutte = tabelle[tabella] ?? []
        const colpite = tutte.filter((r) => filtri.every((f) => f(r)))
        if (operazione === 'update' && patch) {
          for (const r of colpite) Object.assign(r, patch)
          scritture.push({ tabella, operazione, patch, n: colpite.length })
          cronologia.push(`update:${tabella}`)
        }
        if (operazione === 'delete') {
          tabelle[tabella] = tutte.filter((r) => !colpite.includes(r))
          scritture.push({ tabella, operazione, n: colpite.length })
          cronologia.push(`delete:${tabella}`)
        }
        return { data: colpite.map((r) => ({ ...r })), error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => { filtri.push((r) => r[c] === v); return b }
      b.neq = (c: string, v: unknown) => { filtri.push((r) => r[c] !== v); return b }
      b.in = (c: string, v: unknown[]) => { filtri.push((r) => v.includes(r[c])); return b }
      b.is = (c: string, v: unknown) => { filtri.push((r) => (r[c] ?? null) === v); return b }
      // Operatori che `anonimizzaParent` usa su tabelle che qui restano VUOTE
      // (segnalazioni, sospensioni, domande, allegati): trasparenti, perché su una
      // tabella vuota non c'è niente da filtrare.
      b.not = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.order = () => b
      b.range = () => b
      b.update = (p: Riga) => { operazione = 'update'; patch = p; return b }
      b.delete = () => { operazione = 'delete'; return b }
      b.maybeSingle = async () => {
        const { data, error } = esegui()
        return { data: error ? null : (data?.[0] ?? null), error }
      }
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(esegui()).then(ok, ko)
      return b
    },
    storage: {
      from: () => ({
        remove: async () => ({ data: [], error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    },
    auth: { admin: { deleteUser, getUserById, updateUserById } },
  }
  return { client, tabelle, scritture, cronologia, deleteUser, getUserById, updateUserById }
}

/** Una famiglia che se n'è andata: una scheda, un account genitore, un figlio già anonimizzato. */
function tabelleBase(): Record<string, Riga[]> {
  return {
    parents: [{ id: PARENT, auth_user_id: ACCOUNT, fiscal_code: null, documento_path: null, anonimizzato_il: null }],
    utenti: [{ id: ACCOUNT, ruolo: 'genitore', email: EMAIL, nome: NOME, cognome: COGNOME, cellulare: '+39 000 0000000', attivo: true }],
    legame_genitori_alunni: [{ genitore_id: ACCOUNT, alunno_id: FIGLIO_ANONIMIZZATO }],
    alunni: [{ id: FIGLIO_ANONIMIZZATO, anonimizzato_il: '2026-09-14T08:59:00Z' }],
    chat_threads: [],
  }
}

/** La riga di log con quell'esito: `[evento, livello, campi, errore?, opzioni?]`. */
function rigaLog(esito: string) {
  return spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
}

beforeEach(() => {
  spie.logEvento.mockClear()
  spie.logErrore.mockClear()
})

describe('oblio del genitore · l’ACCOUNT si libera insieme alla scheda', () => {
  it('nessun figlio vivo → `deleteUser` con l’id letto PRIMA della patch, dopo aver tolto i legami residui', async () => {
    const m = creaMondo({ tabelle: tabelleBase() })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    // La patch ha davvero staccato il ponte: se l'id si leggesse DOPO, qui non ci sarebbe più.
    expect(m.tabelle.parents[0].auth_user_id).toBeNull()
    expect(m.deleteUser).toHaveBeenCalledTimes(1)
    expect(m.deleteUser).toHaveBeenCalledWith(ACCOUNT)

    // Prima i legami (FK NO ACTION verso `utenti`), poi l'account: al contrario Postgres rifiuta.
    const legami = m.cronologia.indexOf('delete:legame_genitori_alunni')
    const account = m.cronologia.indexOf('auth:deleteUser')
    expect(legami, 'i legami residui non sono stati tolti').toBeGreaterThanOrEqual(0)
    expect(legami).toBeLessThan(account)

    expect(r.account).toBe('rimosso')
    expect(m.tabelle.utenti, 'la riga `utenti` doveva andarsene in cascata').toEqual([])
    expect(m.updateUserById).not.toHaveBeenCalled()

    const riga = rigaLog('account-rimosso')
    expect(riga, 'la cancellazione riuscita non lascia la sua riga: «nessun log» resta ambiguo').toBeTruthy()
    expect(riga![0]).toBe('gdpr')
    expect(riga![1]).toBe('info')
    // Quanti legami residui sono stati sciolti: era uno dei resti dell'incidente.
    expect(riga![2]).toMatchObject({ utente: ACCOUNT, n_legami: 1 })
  })

  it('il ruolo si decide normalizzato, come in `staff-identity`: « Genitore » è un genitore', async () => {
    const tabelle = tabelleBase()
    tabelle.utenti[0].ruolo = ' Genitore '
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')
    expect(r.account).toBe('rimosso')
    expect(m.deleteUser).toHaveBeenCalledWith(ACCOUNT)
  })

  it('cancellazione rifiutata → ripiego: `utenti` e `auth.users` anonimizzati, email non instradabile, ban lunghissimo', async () => {
    const m = creaMondo({
      tabelle: tabelleBase(),
      cancellazioneRifiutata: true,
      metadati: { email: EMAIL, email_verified: true, sub: ACCOUNT },
    })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('anonimizzato')
    const u = m.tabelle.utenti.find((x) => x.id === ACCOUNT)!
    expect(u.email).toBe(EMAIL_ANONIMA)
    expect(String(u.nome)).toMatch(/^CANCELLATO-[0-9A-F]{8}$/)
    expect(String(u.cognome)).toMatch(/^CANCELLATO-[0-9A-F]{8}$/)
    expect(u.cellulare).toBeNull()
    expect(u.attivo).toBe(false)
    // `role` è GENERATA da `ruolo`: scriverla fa fallire l'UPDATE, e `ruolo` non si tocca.
    const patchUtenti = m.scritture.find((s) => s.tabella === 'utenti' && s.operazione === 'update')!.patch!
    expect(Object.keys(patchUtenti)).not.toContain('role')
    expect(Object.keys(patchUtenti)).not.toContain('ruolo')

    expect(m.updateUserById).toHaveBeenCalledTimes(1)
    const [id, attributi] = m.updateUserById.mock.calls[0]
    expect(id).toBe(ACCOUNT)
    expect(attributi.email).toBe(EMAIL_ANONIMA)
    // Senza la conferma GoTrue mette il nuovo indirizzo IN ATTESA e tiene il vecchio.
    expect(attributi.email_confirm).toBe(true)
    // GoTrue FONDE i metadati: `{}` non toglie niente, ogni chiave va messa a null.
    expect(attributi.user_metadata).toEqual({ email: null, email_verified: null, sub: null })
    const ore = Number(String(attributi.ban_duration).replace(/h$/, ''))
    expect(ore, 'il ban deve durare decenni, non ore').toBeGreaterThanOrEqual(24 * 365 * 50)

    // Il corpo del rifiuto non si butta via: è ciò che dice QUALE riferimento ha bloccato.
    const rifiuto = rigaLog('account-cancellazione-rifiutata')
    expect(rifiuto, 'il rifiuto di GoTrue non ha lasciato la sua riga').toBeTruthy()
    expect(rifiuto![2]).toMatchObject({ utente: ACCOUNT })
    expect(rifiuto![3]).toMatchObject({ message: ERRORE_CASCATA.message })
    // …e l'esito dice perché si è anonimizzato invece di cancellare.
    const riga = rigaLog('account-anonimizzato')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('info')
    expect(riga![2]).toMatchObject({ utente: ACCOUNT, tipo: 'cancellazione-rifiutata' })
  })

  it('fallisce anche il ripiego → `non-riuscito`, riga `error` col corpo dell’errore, e l’oblio NON si interrompe', async () => {
    const m = creaMondo({
      tabelle: tabelleBase(),
      cancellazioneRifiutata: true,
      erroreAggiornamentoAuth: ERRORE_AGGIORNAMENTO,
    })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-riuscito')
    // Il resto dell'esito arriva comunque al chiamante: è un passo che non ferma gli altri.
    expect(r.fileNonRimossi).toBe(0)
    const riga = spie.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string }).esito === 'account-non-riuscito' && c[3] !== undefined,
    )
    expect(riga, 'il fallimento non ha una riga `error` con il corpo di GoTrue').toBeTruthy()
    expect(riga![1]).toBe('error')
    expect(riga![2]).toMatchObject({ utente: ACCOUNT })
    expect(riga![3]).toMatchObject({ message: ERRORE_AGGIORNAMENTO.message })
  })

  it('account del PERSONALE che è anche genitore → non si tocca niente, e si dice perché', async () => {
    const tabelle = tabelleBase()
    tabelle.utenti[0].ruolo = 'educator'
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-toccato-personale')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    expect(m.scritture.filter((s) => s.tabella === 'utenti' || s.tabella === 'legame_genitori_alunni')).toEqual([])
    expect(m.tabelle.utenti[0].email).toBe(EMAIL)
    const riga = rigaLog('account-non-toccato-personale')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('info')
    expect(riga![2]).toMatchObject({ utente: ACCOUNT })
  })

  it('un figlio ancora VIVO sull’account → non si tocca: né l’account né i legami', async () => {
    const tabelle = tabelleBase()
    tabelle.legame_genitori_alunni.push({ genitore_id: ACCOUNT, alunno_id: FIGLIO_VIVO })
    tabelle.alunni.push({ id: FIGLIO_VIVO, anonimizzato_il: null })
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-toccato-figli-vivi')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    expect(m.tabelle.legame_genitori_alunni).toHaveLength(2)
    expect(m.tabelle.utenti).toHaveLength(1)
    const riga = rigaLog('account-non-toccato-figli-vivi')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('info')
  })

  it('un’altra scheda `parents` VIVA sullo stesso account → non si tocca', async () => {
    const tabelle = tabelleBase()
    tabelle.parents.push({ id: ALTRA_SCHEDA, auth_user_id: ACCOUNT, anonimizzato_il: null })
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-toccato-figli-vivi')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    expect(m.tabelle.utenti).toHaveLength(1)
  })

  it('una lettura della decisione fallisce → `non-deciso`: non si tocca, e non passa per «nessun figlio»', async () => {
    const m = creaMondo({
      tabelle: tabelleBase(),
      errori: { 'legame_genitori_alunni:select': { code: '42501', message: 'permission denied' } },
    })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-deciso')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    const riga = rigaLog('account-non-deciso')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('error')
    expect(riga![3]).toMatchObject({ code: '42501' })
  })

  it('l’account ha conversazioni di chat → NON si cancella (la cascata porterebbe via i messaggi della maestra): si anonimizza', async () => {
    const tabelle = tabelleBase()
    tabelle.chat_threads = [{ id: 'th-1', parent_id: ACCOUNT, teacher_id: 'maestra' }]
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(r.account).toBe('anonimizzato')
    expect(m.updateUserById).toHaveBeenCalledTimes(1)
    expect(m.tabelle.chat_threads).toHaveLength(1)
    expect(m.tabelle.utenti[0].email).toBe(EMAIL_ANONIMA)
    expect(rigaLog('account-anonimizzato')![2]).toMatchObject({ tipo: 'conversazioni-da-conservare' })
  })

  it('l’account ha risposte agli avvisi (autorizzazioni, prese visione) → NON si cancella: la cascata le distruggerebbe, si anonimizza', async () => {
    // `avvisi_risposte.parent_id` è ON DELETE CASCADE verso `utenti`, e l'oblio non
    // tocca quelle righe: con `deleteUser` sparirebbero atti del genitore che il
    // resto del modello conserva.
    const tabelle = tabelleBase()
    tabelle.avvisi_risposte = [{ id: 'ar-1', parent_id: ACCOUNT, avviso_id: 'avv-1' }]
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(r.account).toBe('anonimizzato')
    expect(m.tabelle.avvisi_risposte).toHaveLength(1)
    expect(m.tabelle.utenti[0].email).toBe(EMAIL_ANONIMA)
    expect(rigaLog('account-anonimizzato')![2]).toMatchObject({ tipo: 'risposte-avvisi-da-conservare' })
  })

  it('le risposte agli avvisi NON si leggono → non si cancella alla cieca: si anonimizza', async () => {
    const m = creaMondo({
      tabelle: tabelleBase(),
      errori: { 'avvisi_risposte:select': { code: 'XX000', message: 'lettura non riuscita' } },
    })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(r.account).toBe('anonimizzato')
    expect(rigaLog('account-anonimizzato')![2]).toMatchObject({ tipo: 'risposte-avvisi-non-lette' })
  })

  it('la scheda NON è stata anonimizzata (patch fallita) → l’account resta com’è, e l’esito lo dichiara', async () => {
    const m = creaMondo({
      tabelle: tabelleBase(),
      errori: { 'parents:update': { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-riuscito')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    expect(m.tabelle.utenti[0].email).toBe(EMAIL)
    expect(m.tabelle.legame_genitori_alunni).toHaveLength(1)
    const riga = rigaLog('account-non-riuscito')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('error')
  })

  it('genitore senza account → `assente`, e lo dice (niente da liberare non è «mai partito»)', async () => {
    const tabelle = tabelleBase()
    tabelle.parents[0].auth_user_id = null
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('assente')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    const riga = rigaLog('account-assente')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('info')
  })

  it('nessuna riga `utenti` → il ruolo non si può verificare: non si tocca, `warn`', async () => {
    const tabelle = tabelleBase()
    tabelle.utenti = []
    const m = creaMondo({ tabelle })
    const r = await anonimizzaParent(m.client as never, PARENT, AT, 'test')

    expect(r.account).toBe('non-toccato-senza-profilo')
    expect(m.deleteUser).not.toHaveBeenCalled()
    expect(m.updateUserById).not.toHaveBeenCalled()
    const riga = rigaLog('account-non-toccato-senza-profilo')
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('warn')
  })

  it('nei log solo uuid: né l’email né il nome della persona, in nessun ramo', async () => {
    const scenari: CfgMondo[] = [
      { tabelle: tabelleBase() },
      { tabelle: tabelleBase(), cancellazioneRifiutata: true, metadati: { email: EMAIL } },
      { tabelle: tabelleBase(), cancellazioneRifiutata: true, erroreAggiornamentoAuth: ERRORE_AGGIORNAMENTO },
    ]
    for (const cfg of scenari) {
      const m = creaMondo(cfg)
      await anonimizzaParent(m.client as never, PARENT, AT, 'test')
    }
    const tutto = JSON.stringify([...spie.logEvento.mock.calls, ...spie.logErrore.mock.calls])
    expect(tutto).not.toContain(EMAIL)
    expect(tutto).not.toContain(NOME)
    expect(tutto).not.toContain(COGNOME)
    expect(tutto).not.toContain(EMAIL_ANONIMA)
  })
})

describe('contaAccountOblio · il riepilogo che finisce nella risposta della Direzione', () => {
  it('conta rimossi, anonimizzati e NON liberati; le scelte deliberate e gli esiti assenti non contano', () => {
    expect(
      contaAccountOblio([
        'rimosso',
        'anonimizzato',
        'anonimizzato',
        'non-riuscito',
        'non-deciso',
        'non-toccato-personale',
        'non-toccato-figli-vivi',
        'non-toccato-senza-profilo',
        'assente',
        undefined,
      ]),
    ).toEqual({ rimossi: 1, anonimizzati: 2, nonLiberati: 2 })
  })
})
