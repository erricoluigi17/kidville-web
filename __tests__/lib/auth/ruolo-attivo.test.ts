import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* ═══════════════════════════════════════════════════════════════════════════════
 * RUOLI REALI (database) vs RUOLO ATTIVO (cookie)
 *
 * ─── IL FATTO MISURATO IN PRODUZIONE ───────────────────────────────────────────
 *
 * Quattro persone hanno insieme una riga `utenti` con ruolo `educator` E il ponte
 * `parents.auth_user_id` sullo stesso `auth.uid()`: sono insegnanti che sono anche
 * genitori di un bambino della scuola. Sei dei loro legami figlio↔genitore cadono
 * FUORI dalle sezioni che insegnano, e uno è in un'altra sede: aprendo il diario
 * del PROPRIO figlio ricevono «403 — Alunno non nella tua classe».
 *
 * ─── LA DECISIONE, IN UNA RIGA ─────────────────────────────────────────────────
 *
 *   AUTORIZZAZIONE = unione dei ruoli REALI (database).
 *   PRESENTAZIONE  = ruolo ATTIVO (cookie `kv-active-role`).
 *
 * Il cookie non concede e non revoca niente: sceglie QUALE delle proprie viste
 * legittime si sta guardando. Non è un'escalation perché `getProfiliForAuthUid`
 * produce al massimo due profili — uno da `utenti.ruolo` (colonna scalare) e
 * `genitore` solo se esiste il ponte — e `POST /api/auth/active-role` rifiuta già
 * un ruolo che non sia fra quelli.
 *
 * ─── IL BUCO CHE QUESTO FILE CHIUDE ────────────────────────────────────────────
 *
 * Oggi la validazione del cookie avviene al SET, non all'USO, e il cookie dura 180
 * giorni. Se la direzione degrada un `educator` a `cuoca`, il cookie continua a
 * dire `educator` per sei mesi: nessuno lo ri-guarda. Qui il ruolo attivo si
 * ri-valida a OGNI richiesta contro i ruoli letti IN QUELLA STESSA richiesta —
 * ed è il test «ruolo revocato» in fondo a provarlo.
 * ═══════════════════════════════════════════════════════════════════════════════ */

// Gli stessi due client che `resolveIdentity` tocca, con la stessa forma di mock del
// vicino `__tests__/lib/resolveIdentity.test.ts`:
//  - createClient()      → il client di sessione (legge il cookie di auth)
//  - createAdminClient() → service-role, mappa auth.uid() → id applicativo
// `single` è il metodo di `loadAppUser`, `maybeSingle` quello dei due lookup di identità:
// tenerli separati è ciò che permette di provare CHE la riga già letta viene riusata.
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  utentiMaybeSingle: vi.fn(),
  parentsMaybeSingle: vi.fn(),
  utentiSingle: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mocks.getUser } }),
  createAdminClient: vi.fn().mockResolvedValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: table === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
          single: mocks.utentiSingle,
        }),
      }),
    }),
  }),
}))

// `logErrore`/`logOk` servono a `withRoute`, che avvolge `POST /api/auth/active-role`:
// senza, l'import della route fallirebbe. Restano spie mute.
vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import {
  resolveIdentity,
  requireDocente,
  requireStaff,
  requireUser,
  requireKitchenRead,
  ruoliDi,
  haRuolo,
  haUnRuolo,
  agisceComeGenitore,
  eFamiglia,
  type AppUser,
} from '@/lib/auth/require-staff'
import {
  ACTIVE_ROLE_COOKIE,
  areeDeiProfili,
  areeDelRuolo,
  isAreaAllowed,
  leggiCookie,
  risolviRuoloAttivo,
} from '@/lib/auth/active-role'
import { POST as cambiaRuoloAttivo } from '@/app/api/auth/active-role/route'
import { logEvento } from '@/lib/logging/logger'
import { CHIAVI_IN_CHIARO, redact } from '@/lib/logging/redact'
import { SEDE_A } from '../../fixtures/sedi'

/** `auth.uid()` della persona sotto test: coincide con `utenti.id` quando la riga c'è. */
const UID = 'd0000000-0000-4000-8000-0000000000d1'
/** `parents.id`: riga d'anagrafica SEPARATA, non è l'id applicativo di chi ha anche `utenti`. */
const PARENT_ROW = 'd0000000-0000-4000-8000-0000000000a1'

/** La riga `utenti` come la legge `resolveIdentity` sul percorso sessione. */
function rigaUtenti(ruolo: string) {
  return { id: UID, nome: 'X', cognome: 'Y', ruolo, role: ruolo, scuola_id: SEDE_A }
}

/** Una richiesta con (o senza) il cookie del ruolo attivo. */
function richiesta(cookie?: string): Request {
  return new Request(
    'http://localhost/api/diary/students',
    cookie ? { headers: { cookie: `${ACTIVE_ROLE_COOKIE}=${cookie}` } } : undefined,
  )
}

/** Sessione reale: `auth.uid()` risolto, nessun header legacy in gioco. */
function conSessione(ruolo: string | null, ponte: boolean) {
  mocks.getUser.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  mocks.utentiMaybeSingle.mockResolvedValue({ data: ruolo ? rigaUtenti(ruolo) : null, error: null })
  mocks.parentsMaybeSingle.mockResolvedValue({ data: ponte ? { id: PARENT_ROW } : null, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
  mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.utentiSingle.mockResolvedValue({ data: null, error: { message: 'no rows' } })
})
afterEach(() => vi.unstubAllEnvs())

/* ────────────────────────────────────────────────────────────────────────────
 * 1. `leggiCookie` — perché non `next/headers`
 *
 * `cookies()` di Next LANCIA fuori da un contesto di richiesta, e i ~90 test API
 * di questo repo invocano gli handler con una `Request` nuda. Un `require-staff`
 * che importasse `next/headers` avrebbe bisogno di un `try/catch` obbligato per
 * costruzione — cioè un catch che inghiotte sempre, che è il difetto che
 * AGENTS.md regola 6 vieta. Con l'intestazione `Cookie` la funzione è PURA.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('leggiCookie — puro, dalla richiesta, senza next/headers', () => {
  it('trova il valore per nome', () => {
    expect(leggiCookie('kv-active-role=genitore', 'kv-active-role')).toBe('genitore')
  })

  it('trova il valore fra altri cookie, con e senza spazi', () => {
    expect(leggiCookie('a=1; kv-active-role=educator; b=2', 'kv-active-role')).toBe('educator')
    expect(leggiCookie('a=1;kv-active-role=educator;b=2', 'kv-active-role')).toBe('educator')
  })

  it('intestazione assente o cookie assente → null', () => {
    expect(leggiCookie(null, 'kv-active-role')).toBeNull()
    expect(leggiCookie('', 'kv-active-role')).toBeNull()
    expect(leggiCookie('a=1; b=2', 'kv-active-role')).toBeNull()
  })

  it('non confonde un nome che CONTIENE quello cercato (prefisso/suffisso)', () => {
    // `x-kv-active-role` e `kv-active-role-2` non sono `kv-active-role`: un match
    // per `includes` qui darebbe il valore sbagliato — cioè il ruolo sbagliato.
    expect(leggiCookie('x-kv-active-role=admin', 'kv-active-role')).toBeNull()
    expect(leggiCookie('kv-active-role-2=admin', 'kv-active-role')).toBeNull()
  })

  it('un cookie senza `=` non fa saltare il parsing', () => {
    expect(leggiCookie('rotto; kv-active-role=cuoca', 'kv-active-role')).toBe('cuoca')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2. La matrice delle aree in UN posto solo
 * ──────────────────────────────────────────────────────────────────────────── */

describe('areeDelRuolo / areeDeiProfili — fonte unica della matrice', () => {
  it('lo staff di gestione apre admin e teacher; educator solo teacher; genitore solo parent', () => {
    expect([...areeDelRuolo('admin')].sort()).toEqual(['admin', 'teacher'])
    expect([...areeDelRuolo('segreteria')].sort()).toEqual(['admin', 'teacher'])
    expect([...areeDelRuolo('cuoca')]).toEqual(['admin'])
    expect([...areeDelRuolo('educator')]).toEqual(['teacher'])
    expect([...areeDelRuolo('genitore')]).toEqual(['parent'])
  })

  it('ruolo ignoto: nessuna area (fail-closed)', () => {
    expect([...areeDelRuolo('hacker')]).toEqual([])
    expect([...areeDelRuolo('')]).toEqual([])
  })

  it('`isAreaAllowed` resta il contratto di prima, ora DERIVATO dalla matrice', () => {
    expect(isAreaAllowed('educator', 'teacher')).toBe(true)
    expect(isAreaAllowed('educator', 'parent')).toBe(false)
    expect(isAreaAllowed('hacker', 'admin')).toBe(false)
  })

  it('le aree di più profili si uniscono senza doppioni', () => {
    const doppio = [{ ruolo: 'educator' }, { ruolo: 'genitore' }]
    expect([...areeDeiProfili(doppio)].sort()).toEqual(['parent', 'teacher'])
    const staffEGenitore = [{ ruolo: 'segreteria' }, { ruolo: 'genitore' }]
    expect([...areeDeiProfili(staffEGenitore)].sort()).toEqual(['admin', 'parent', 'teacher'])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 3. `risolviRuoloAttivo` — la risoluzione che era duplicata in due punti
 *    identici carattere per carattere (area-guard.ts:35-40 e :67-72)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('risolviRuoloAttivo', () => {
  const doppio = [{ ruolo: 'educator' }, { ruolo: 'genitore' }]

  it('profilo unico: il cookie non serve, vince il proprio ruolo', () => {
    expect(risolviRuoloAttivo([{ ruolo: 'educator' }], null)).toBe('educator')
    expect(risolviRuoloAttivo([{ ruolo: 'educator' }], 'genitore')).toBe('educator')
  })

  it('doppio profilo col cookie fra i propri: è quello', () => {
    expect(risolviRuoloAttivo(doppio, 'genitore')).toBe('genitore')
    expect(risolviRuoloAttivo(doppio, 'educator')).toBe('educator')
  })

  it('doppio profilo senza cookie valido → `null`: la scelta è AMBIGUA, non decisa a caso', () => {
    expect(risolviRuoloAttivo(doppio, null)).toBeNull()
    expect(risolviRuoloAttivo(doppio, 'admin')).toBeNull()
    expect(risolviRuoloAttivo(doppio, 'ruolo-inventato')).toBeNull()
  })

  it('nessun profilo → null', () => {
    expect(risolviRuoloAttivo([], 'educator')).toBeNull()
    expect(risolviRuoloAttivo(null, 'educator')).toBeNull()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 4. I predicati: AUTORIZZAZIONE (ruoli reali) vs PRESENTAZIONE (ruolo attivo)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('ruoliDi / haRuolo / haUnRuolo / agisceComeGenitore / eFamiglia', () => {
  const semplice: AppUser = { id: UID, role: 'educator' }
  const doppio: AppUser = { id: UID, role: 'genitore', ruoli: ['educator', 'genitore'] }

  it('senza `ruoli`, l\'unico ruolo è `role`: è la semantica di OGGI per i 617 utenti non doppi', () => {
    expect([...ruoliDi(semplice)]).toEqual(['educator'])
    expect(haRuolo(semplice, 'educator')).toBe(true)
    expect(haRuolo(semplice, 'genitore')).toBe(false)
  })

  it('`haUnRuolo` guarda i ruoli REALI, non la veste indossata', () => {
    // In modalità genitore, la persona resta educator PER IL DATABASE.
    expect(haUnRuolo(doppio, ['educator', 'admin'])).toBe(true)
    expect(haUnRuolo(doppio, ['admin', 'coordinator'])).toBe(false)
  })

  it('`agisceComeGenitore` è PRESENTAZIONE: guarda il ruolo attivo', () => {
    expect(agisceComeGenitore(doppio)).toBe(true)
    expect(agisceComeGenitore({ ...doppio, role: 'educator' })).toBe(false)
  })

  it('`eFamiglia` è AUTORIZZAZIONE: guarda i ruoli reali, e non cambia con la veste', () => {
    expect(eFamiglia(doppio)).toBe(true)
    // Stessa persona, veste docente: è ANCORA un genitore per il database.
    expect(eFamiglia({ ...doppio, role: 'educator' })).toBe(true)
    expect(eFamiglia(semplice)).toBe(false)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 5. `resolveIdentity` è ADDITIVA: porta la riga GIÀ LETTA e il ponte genitore
 * ──────────────────────────────────────────────────────────────────────────── */

describe('resolveIdentity — riga già letta e ponte genitore', () => {
  it('percorso sessione: restituisce la riga `utenti` e dice se il ponte esiste', async () => {
    conSessione('educator', true)
    const res = await resolveIdentity(richiesta())
    expect(res.userId).toBe(UID)
    expect(res.source).toBe('session')
    expect(res.rigaUtenti).toMatchObject({ id: UID, ruolo: 'educator' })
    expect(res.ponteGenitore).toBe(true)
  })

  it('`utenti` VINCE su `parents`: invertire rimapperebbe l\'id di un docente-genitore', async () => {
    // `getFigliDiGenitoreEsito` cerca `legame_genitori_alunni.genitore_id = accountId`:
    // con `parents.id` al posto dell'id `utenti` smetterebbe di trovarlo, e si romperebbe
    // esattamente ciò che questo lavoro vuole aggiustare.
    conSessione('educator', true)
    expect((await resolveIdentity(richiesta())).userId).toBe(UID)
  })

  it('genitore reale senza riga `utenti`: id dal ponte, `rigaUtenti` nulla', async () => {
    conSessione(null, true)
    const res = await resolveIdentity(richiesta())
    expect(res.userId).toBe(PARENT_ROW)
    expect(res.rigaUtenti).toBeNull()
    expect(res.ponteGenitore).toBe(true)
  })

  it('percorso header legacy: niente riga e niente ponte (non si è letto nulla)', async () => {
    const res = await resolveIdentity(
      new Request('http://localhost/api/x', { headers: { 'x-user-id': 'hdr-1' } }),
    )
    expect(res).toMatchObject({ userId: 'hdr-1', source: 'header' })
    expect(res.rigaUtenti).toBeUndefined()
    expect(res.ponteGenitore).toBeUndefined()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 6. IL CUORE — il ruolo attivo nei gate
 * ──────────────────────────────────────────────────────────────────────────── */

describe('ruolo attivo nei gate', () => {
  it('cookie `genitore` + `utenti.ruolo=educator` + ponte → veste genitore, ruoli reali entrambi', async () => {
    conSessione('educator', true)
    const auth = await requireUser(richiesta('genitore'))
    expect(auth.response).toBeUndefined()
    expect(auth.user?.role).toBe('genitore')
    expect([...ruoliDi(auth.user!)].sort()).toEqual(['educator', 'genitore'])
  })

  it('cookie `genitore` ma NESSUN ponte: il cookie è ignorato', async () => {
    conSessione('educator', false)
    const auth = await requireUser(richiesta('genitore'))
    expect(auth.user?.role).toBe('educator')
    expect([...ruoliDi(auth.user!)]).toEqual(['educator'])
  })

  it('cookie `admin` su un docente-genitore: `admin` non è fra i suoi ruoli reali → ignorato', async () => {
    conSessione('educator', true)
    const auth = await requireUser(richiesta('admin'))
    expect(auth.user?.role).toBe('educator')
  })

  it('ruolo IGNOTO nel cookie → ignorato (`parseActiveRole` è a lista chiusa)', async () => {
    conSessione('educator', true)
    const auth = await requireUser(richiesta('superadmin'))
    expect(auth.user?.role).toBe('educator')
  })

  it('nessun cookie → `role` è `utenti.ruolo`, identico a oggi', async () => {
    conSessione('educator', true)
    const auth = await requireUser(richiesta())
    expect(auth.user?.role).toBe('educator')
  })

  /**
   * ─── PERCORSO HEADER: DUE ASSERZIONI SEPARATE, E PERCHÉ ─────────────────────
   *
   * Prima erano un test solo, e stavano insieme per comodità. Misurato con una
   * mutazione deliberata (si è fatto riportare il ponte anche al percorso header):
   * il test cadeva sull'asserzione dei RUOLI e non arrivava mai a esercitare la
   * guardia `source !== 'session'` — cioè la copriva senza provarla. Un test che
   * non si è mai visto fallire per la ragione che dichiara non è un test.
   *
   * Separate, ognuna ha il suo mutante:
   *  · la prima cade se il percorso header comincia a riportare il ponte;
   *  · la seconda cade solo se, con il ponte riportato, si TOGLIE la guardia —
   *    ed è esattamente il difetto che la guardia esiste per impedire.
   */
  const richiestaHeader = () =>
    new Request('http://localhost/api/x', {
      headers: { 'x-user-id': UID, cookie: `${ACTIVE_ROLE_COOKIE}=genitore` },
    })

  it('percorso HEADER: non si è letto nessun ponte, quindi il ruolo reale è uno solo', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
    mocks.utentiSingle.mockResolvedValue({ data: rigaUtenti('educator'), error: null })
    const auth = await requireUser(richiestaHeader())
    expect([...ruoliDi(auth.user!)]).toEqual(['educator'])
  })

  it('percorso HEADER: la VESTE resta `utenti.ruolo`, il cookie non la cambia', async () => {
    // Cookie del browser A + header con l'id di B è una combinazione che nessuno può
    // provare legittima: sul percorso legacy il ruolo attivo si ignora per principio,
    // non perché «tanto non c'è il ponte». È la guardia `source !== 'session'`.
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
    mocks.utentiSingle.mockResolvedValue({ data: rigaUtenti('educator'), error: null })
    const auth = await requireUser(richiestaHeader())
    expect(auth.user?.role).toBe('educator')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 7. IL COOKIE NON È MAI UN INGRESSO — i due test di sicurezza che contano
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il cookie non concede niente', () => {
  it('SICUREZZA · genitore puro con cookie FORGIATO `educator`: requireDocente → 403', async () => {
    conSessione('genitore', true)
    const auth = await requireDocente(richiesta('educator'))
    expect(auth.response?.status).toBe(403)
    expect(await auth.response!.json()).toEqual({
      error: 'Accesso negato: riservato al personale docente',
    })
  })

  it('SICUREZZA · genitore puro con cookie forgiato `admin`: requireStaff → 403', async () => {
    conSessione('genitore', true)
    const auth = await requireStaff(richiesta('admin'))
    expect(auth.response?.status).toBe(403)
  })

  it('SICUREZZA · RUOLO REVOCATO: il cookie `educator` dura 180 giorni, il ruolo no', async () => {
    // La direzione ha degradato l'educator a `cuoca`. Il cookie in mano al browser dice
    // ancora `educator` e continuerà a dirlo per sei mesi: è per questo che il ruolo
    // attivo si ri-valida contro i ruoli letti IN QUESTA richiesta, non al momento del set.
    conSessione('cuoca', true)
    const auth = await requireDocente(richiesta('educator'))
    expect(auth.response?.status).toBe(403)

    // …e la veste che resta è quella vera, non quella del cookie.
    const ancoraDentro = await requireKitchenRead(richiesta('educator'))
    expect(ancoraDentro.response).toBeUndefined()
    expect(ancoraDentro.user?.role).toBe('cuoca')
  })

  it('passare in modalità genitore NON chiude fuori dalle API docente', async () => {
    // Conseguenza VOLUTA della regola «i gate guardano i ruoli reali»: durante il
    // rollout, una seconda scheda del browser rimasta su /teacher non comincia a
    // rispondere 403 misteriosi solo perché in un'altra scheda si è cambiata veste.
    conSessione('educator', true)
    const auth = await requireDocente(richiesta('genitore'))
    expect(auth.response).toBeUndefined()
    expect(auth.user?.role).toBe('genitore') // la VESTE è genitore…
    expect(haRuolo(auth.user!, 'educator')).toBe(true) // …ma il permesso resta
  })

  it('un genitore puro resta fuori da requireDocente anche senza cookie (nessuna regressione)', async () => {
    conSessione('genitore', true)
    expect((await requireDocente(richiesta())).response?.status).toBe(403)
  })

  it('DEDUP · genitore in `utenti` PIÙ il ponte è UN ruolo solo, non due uguali', async () => {
    // È lo stesso invariante di `getProfiliForAuthUid` («un genitore-demo in `utenti`
    // che avesse anche il ponte resta UN profilo»), e qui non è un dettaglio estetico:
    // con `['genitore','genitore']` la persona risulterebbe a DUE vesti, il ramo del
    // ruolo attivo si accenderebbe per chi non ha niente da scegliere, e la riga di
    // diniego direbbe `doppio: true` su un utente che doppio non è.
    conSessione('genitore', true)
    const auth = await requireUser(richiesta())
    expect([...ruoliDi(auth.user!)]).toEqual(['genitore'])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 7-bis. IL DINIEGO DICE ANCHE «QUESTA PERSONA HA DUE VESTI»
 *
 * Senza, un 403 a un docente-genitore in modalità genitore è indistinguibile da
 * un 403 a un estraneo: stesso status, stesso corpo, stessa riga di log. Con
 * `doppio`, chi legge `app_log` sa che quel diniego può essere «sta guardando
 * l'app dal lato sbagliato» e non «non può».
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il diniego distingue chi ha due vesti', () => {
  /** L'ultima riga di diniego scritta dai gate. */
  const diniego = () => {
    const calls = vi.mocked(logEvento).mock.calls.filter((c) => {
      const campi = c[2] as { azione?: string } | undefined
      return typeof campi?.azione === 'string'
    })
    return calls.at(-1)?.[2] as Record<string, unknown> | undefined
  }

  it('docente-genitore in veste genitore, negato da un gate di Direzione: `doppio: true`', async () => {
    conSessione('educator', true)
    const auth = await requireStaff(richiesta('genitore'), ['admin', 'coordinator'])
    expect(auth.response?.status).toBe(403)
    expect(diniego()).toEqual({
      tipo: 'ruolo-negato',
      azione: 'requireStaff',
      // `ruolo` è la VESTE con cui ha bussato: è ciò che serve a capire il diniego.
      ruolo: 'genitore',
      doppio: true,
    })
  })

  it('utente con una veste sola: il campo NON compare nella riga emessa', async () => {
    // Questa riga si scrive a OGNI 401/403 — gli eventi più frequenti che un'app
    // autenticata produca — e un `doppio=false` costante sarebbe rumore in tabella.
    //
    // Si asserisce sulla RIGA EMESSA, non sulle chiavi dell'oggetto: `{ doppio: undefined }`
    // ha comunque la chiave in JavaScript, quindi `Object.keys` direbbe che il campo c'è
    // mentre nel log non c'è. È `formattaRiga` a decidere — salta `undefined`, `null` e
    // stringa vuota — ed è quello il comportamento che conta e che qui si congela, usando
    // il formattatore VERO e non una sua imitazione.
    const { formattaRiga } = await vi.importActual<typeof import('@/lib/logging/logger')>(
      '@/lib/logging/logger',
    )
    conSessione('genitore', false)
    const auth = await requireStaff(richiesta())
    expect(auth.response?.status).toBe(403)

    const campi = diniego()!
    expect(campi).toEqual({ tipo: 'ruolo-negato', azione: 'requireStaff', ruolo: 'genitore' })
    const riga = formattaRiga('auth', campi as Record<string, string | number | boolean | null | undefined>)
    expect(riga).toContain('ruolo=genitore')
    expect(riga).not.toContain('doppio')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 8. I 617 UTENTI NON DOPPI — il criterio di successo più importante
 * ──────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────
 * 9. IL 403 MUTO di `POST /api/auth/active-role`
 *
 * È l'UNICO punto del sistema che possa vedere un tentativo di cambio ruolo non
 * autorizzato, ed era cieco: rispondeva «Ruolo non disponibile» e non lasciava
 * traccia da nessuna parte. È la stessa forma di difetto già pagata altrove —
 * «dodici 403 corretti e in `app_log` non c'era una sola riga».
 * ──────────────────────────────────────────────────────────────────────────── */

describe('POST /api/auth/active-role — il cambio veste si vede nei log', () => {
  const chiedi = (ruolo: string) =>
    cambiaRuoloAttivo(
      new Request('http://localhost/api/auth/active-role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruolo }),
      }),
    )

  /** Le chiamate a `logEvento` con un `tipo` che comincia per `ruolo-attivo`. */
  const righe = () =>
    vi.mocked(logEvento).mock.calls.filter((c) => {
      const campi = c[2] as { tipo?: string } | undefined
      return typeof campi?.tipo === 'string' && campi.tipo.startsWith('ruolo-attivo')
    })

  it('403 · un ruolo che non è fra i propri lascia una riga PERSISTITA (`warn`)', async () => {
    conSessione('educator', true) // profili: educator + genitore. `admin` no.
    const res = await chiedi('admin')
    expect(res.status).toBe(403)

    expect(logEvento).toHaveBeenCalledWith('auth', 'warn', {
      tipo: 'ruolo-attivo-non-disponibile',
      utente: UID,
      ruolo: 'admin',
    })

    // Il livello NON è decorativo: `warn` è ciò che manda la riga in tabella, e un
    // tentativo di cambio ruolo non autorizzato è un segnale di sicurezza, non rumore.
    // Si asserisce sul logger VERO, perché è lì che vive la regola.
    const vero = await vi.importActual<typeof import('@/lib/logging/logger')>('@/lib/logging/logger')
    expect(vero.vaPersistito('warn', 'auth')).toBe(true)
  })

  it('200 · anche il SUCCESSO parla: senza, «nessun log» non distingue niente', async () => {
    conSessione('educator', true)
    const res = await chiedi('genitore')
    expect(res.status).toBe(200)
    expect(logEvento).toHaveBeenCalledWith('auth', 'info', {
      tipo: 'ruolo-attivo-cambiato',
      utente: UID,
      ruolo: 'genitore',
    })
  })

  it('la riga sopravvive a `redact()`: `tipo` e `ruolo` sono in lista bianca, `utente` è un uuid', async () => {
    // Non è una formalità: `redact()` è a LISTA BIANCA PER CHIAVE, e una riga
    // persistita ma illeggibile (`[redatto:str/N]`) non dice più QUALE segnale era —
    // è l'errore già commesso una volta con `motivo` al posto di `tipo`.
    expect(CHIAVI_IN_CHIARO).toContain('tipo')
    expect(CHIAVI_IN_CHIARO).toContain('ruolo')
    // `utente` NON è in lista bianca: passa perché il VALORE è un uuid, cioè
    // auto-descrittivo per forma. Vale per la sessione (id di `utenti`/`parents`);
    // sul percorso legacy un id non-uuid uscirà redatto, ed è il verso giusto.
    expect(CHIAVI_IN_CHIARO).not.toContain('utente')
    expect(
      redact({ tipo: 'ruolo-attivo-non-disponibile', utente: UID, ruolo: 'admin' }),
    ).toEqual({ tipo: 'ruolo-attivo-non-disponibile', utente: UID, ruolo: 'admin' })
  })

  it('nessuna riga quando non c\'è niente da dire (401 senza identità)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await chiedi('genitore')
    expect(res.status).toBe(401)
    expect(righe()).toHaveLength(0)
  })
})

describe('per chi ha un ruolo solo non cambia NIENTE', () => {
  for (const ruolo of ['admin', 'coordinator', 'segreteria', 'cuoca', 'educator', 'genitore']) {
    it(`${ruolo}: nessun ponte → l'utente è quello di prima, campo per campo`, async () => {
      conSessione(ruolo, false)
      const auth = await requireUser(richiesta(ruolo === 'educator' ? 'genitore' : 'educator'))
      // `toEqual` e non `toMatchObject`: qui si asserisce che NON è comparso nessun
      // campo nuovo. `ruoli` deve restare ASSENTE, perché il default (`[role]`) è già
      // esattamente la semantica di oggi e un campo in più è una superficie in più.
      expect(auth.user).toEqual({
        id: UID,
        role: ruolo,
        nome: 'X',
        cognome: 'Y',
        scuola_id: SEDE_A,
      })
    })
  }
})
