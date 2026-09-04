import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { VERSIONE_TERMINI } from '@/lib/legal/versioni'
import { valutaPasswordNuova } from '@/lib/auth/regole-password'
import { CASI_PASSWORD } from '../helpers/casi-password'

// P4/DL-045 — POST /api/parent/onboarding: consensi GDPR obbligatori + (opzionale)
// set password Supabase Auth; marca onboarded_at sul genitore.
// C5 — i Termini di servizio sono ora obbligatori e ogni consenso accettato viene
// registrato (append-only) in consensi_accettazioni con VERSIONE decisa server-side.

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  parent: { id: 'p1', auth_user_id: 'auth-1' } as Record<string, unknown> | null,
  parentNotFound: false,
  updates: [] as Array<Record<string, unknown>>,
  /** OGNI `.eq` vista su `parents`, da qualunque catena: serve al «mai per `id`». */
  eqCalls: [] as Array<[string, unknown]>,
  /** Solo le `.eq` della catena che parte da `.update()`: il WHERE dell'UPDATE. */
  updateEqCalls: [] as Array<[string, unknown]>,
  pwUpdates: [] as Array<{ uid: string; attrs: unknown }>,
  consensiInserts: [] as Array<Record<string, unknown>>,
  consensiInsertErr: null as unknown,
  parentUpdateErr: null as unknown,
  /** Esito di `auth.admin.updateUserById` (GoTrue): null = riuscito. */
  pwErr: null as unknown,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    auth: { admin: { updateUserById: async (uid: string, attrs: unknown) => { h.pwUpdates.push({ uid, attrs }); return { data: h.pwErr ? null : {}, error: h.pwErr } } } },
    from: (table: string) => {
      const maybeSingle = async () => ({
        data: h.parentUpdateErr || h.parentNotFound ? null : h.parent,
        error: h.parentUpdateErr,
      })

      // ⚠️ DUE CATENE, DUE ACCUMULATORI — e non è pignoleria (2026-09-03).
      //
      // Fino a oggi `b.update()` restituiva `b`, cioè LO STESSO builder della
      // lettura, e ogni `.eq` finiva in un unico `eqCalls`. Da quando la route
      // deduce la sede dai FIGLI passa da `getFigliDiGenitore`, che legge il
      // ponte con `from('parents').select('id').eq('auth_user_id', accountId)`
      // (`src/lib/anagrafiche/legami.ts:83-84`): la sua `.eq` riempiva
      // `eqCalls` al posto di quella dell'UPDATE. Risultato misurato:
      // cancellando `.eq('auth_user_id', auth.user.id)` dall'UPDATE di
      // `parents` — cioè riscrivendo i consensi GDPR di TUTTI i genitori, senza
      // WHERE — la suite restava verde 28 su 28. Un accumulatore che mescola
      // due catene non misura nessuna delle due.
      const catenaUpdate: Record<string, unknown> = {}
      catenaUpdate.eq = (col: string, val: unknown) => {
        if (table === 'parents') { h.eqCalls.push([col, val]); h.updateEqCalls.push([col, val]) }
        return catenaUpdate
      }
      catenaUpdate.select = () => catenaUpdate
      catenaUpdate.maybeSingle = maybeSingle

      const b: Record<string, unknown> = {}
      b.update = (row: Record<string, unknown>) => { h.updates.push(row); return catenaUpdate }
      b.eq = (col: string, val: unknown) => { if (table === 'parents') h.eqCalls.push([col, val]); return b }
      b.select = () => b
      b.maybeSingle = maybeSingle
      b.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(rows) ? rows : [rows]
        if (table === 'consensi_accettazioni') h.consensiInserts.push(...arr)
        return Promise.resolve({ data: null, error: h.consensiInsertErr })
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/parent/onboarding/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/parent/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
  h.parent = { id: 'p1', auth_user_id: 'auth-1' }
  h.updates = []; h.eqCalls = []; h.updateEqCalls = []; h.pwUpdates = []; h.consensiInserts = []; h.consensiInsertErr = null; h.parentUpdateErr = null; h.parentNotFound = false; h.pwErr = null
})

/**
 * Una password che SUPERA la regola condivisa (`@/lib/auth/regole-password`) — inventata, come
 * ogni credenziale che compare in questo repo pubblico.
 *
 * Era `'unaPasswordLunga'`, scelta quando l'unico requisito era «almeno 8 caratteri»: sedici
 * caratteri e nessuna cifra. Dal 2026-09-01 la regola pretende anche una cifra, e con quel
 * valore i tre test qui sotto si fermavano al gate — cioè smettevano di misurare ciò che
 * dichiarano (che cosa succede DOPO la risposta di GoTrue) pur restando scritti come se lo
 * misurassero. Il fixture di un test che parla del passo successivo deve superare il passo
 * precedente, altrimenti il test cambia argomento senza dirlo.
 */
const PASSWORD_VALIDA = 'unaPassword1Lunga'

/** I `logEvento` emessi con un dato livello, per `esito`. */
const esitiLoggati = (livello: string): string[] =>
  h.logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => String((c[2] as { esito?: string })?.esito ?? ''))

describe('POST /api/parent/onboarding', () => {
  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(req({ consensi: { privacy: true, termini: true } }))).status).toBe(401)
  })

  it('422 se manca il consenso privacy', async () => {
    const res = await POST(req({ consensi: { privacy: false, termini: true } }))
    expect(res.status).toBe(422)
    expect((await res.json()).mancanti).toContain('privacy')
  })

  it('422 se mancano i Termini (C5)', async () => {
    const res = await POST(req({ consensi: { privacy: true } }))
    expect(res.status).toBe(422)
    expect((await res.json()).mancanti).toContain('termini')
    // Nessuna prova di consenso registrata se l'onboarding non passa.
    expect(h.consensiInserts).toHaveLength(0)
  })

  it('400 se la password è troppo corta', async () => {
    expect((await POST(req({ consensi: { privacy: true, termini: true }, password: 'abc' }))).status).toBe(400)
  })

  // ── La regola della password sta in UN POSTO SOLO (2026-09-01) ─────────────
  // Questa route pretendeva 8 caratteri; `supabase/config.toml` ne dichiara 6 al
  // provider; la schermata che la chiama ne ripeteva 8 per conto suo. Tre numeri
  // per lo stesso gesto, e nessun test poteva vederli diversi: ogni copia era
  // coerente con sé stessa. Ora il giudizio è di `@/lib/auth/regole-password`, e
  // i tre casi qui sotto sono quelli che il vecchio `length < 8` LASCIAVA PASSARE.
  it('400 su una password di 9 caratteri: il minimo è quello del modulo condiviso, non 8', async () => {
    const nove = 'abcdefg12'
    expect(nove).toHaveLength(9)
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: nove }))
    expect(res.status).toBe(400)
    // Il gate scatta PRIMA di GoTrue: la password non viene nemmeno tentata.
    expect(h.pwUpdates).toHaveLength(0)
    expect(esitiLoggati('info')).toContain('password-onboarding-rifiutata')
  })

  it('400 su una password senza cifre, per quanto lunga (policy `letters_digits` di GoTrue)', async () => {
    // Senza questo controllo la respingerebbe GoTrue, dopo, con un messaggio che
    // il genitore non può interpretare — ed è il rifiuto opaco che la regola evita.
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: 'parolachiavelunga' }))
    expect(res.status).toBe(400)
    expect(h.pwUpdates).toHaveLength(0)
  })

  it('esattamente 10 caratteri con lettera e cifra: passa, e la password arriva a GoTrue', async () => {
    const dieci = 'abcdefgh12'
    expect(dieci).toHaveLength(10)
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: dieci }))
    expect(res.status).toBe(200)
    expect(h.pwUpdates).toHaveLength(1)
  })

  // ── LO STESSO VERDETTO DEL CLIENT, SUGLI STESSI INPUT ─────────────────────
  //
  // La tabella è `__tests__/helpers/casi-password.ts`, e la attraversa anche
  // `__tests__/components/parent-onboarding-password.test.tsx`. Il difetto che
  // chiude non stava né in questo file né in quello: stava NELLO SPAZIO FRA I DUE
  // — il client si fermava a `length < 8` e questa route ne pretendeva 10, e
  // ciascuno dei due test era coerente con la propria metà.
  //
  // Qui si verifica anche il CODICE: senza, la risposta ricadrebbe sul messaggio
  // generico della schermata («Operazione non riuscita»), che è la metà peggiore
  // del difetto — quella che lascia il genitore senza sapere cosa correggere.
  describe.each(CASI_PASSWORD.filter((c) => c.scritta !== ''))('«$scritta» → $atteso', (caso) => {
    it(caso.perche, async () => {
      const regola = valutaPasswordNuova(caso.scritta)
      expect(regola.ok ? 'OK' : regola.codice, 'la tabella non descrive più la regola').toBe(caso.atteso)

      const res = await POST(req({ consensi: { privacy: true, termini: true }, password: caso.scritta }))
      const j = await res.json()

      if (caso.atteso === 'OK') {
        expect(res.status).toBe(200)
        expect(h.pwUpdates).toHaveLength(1)
        return
      }
      expect(res.status).toBe(400)
      expect(j.codice).toBe(caso.atteso)
      // Il gate scatta PRIMA di GoTrue: la password non viene nemmeno tentata.
      expect(h.pwUpdates).toHaveLength(0)
    })
  })

  it('un campo password lasciato VUOTO non è un rifiuto: è «nessuna password»', async () => {
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: '' }))
    expect(res.status).toBe(200)
    expect(h.pwUpdates).toHaveLength(0)
  })

  it('nessun log della password rifiutata porta la password (esce solo il codice)', async () => {
    await POST(req({ consensi: { privacy: true, termini: true }, password: 'abcdefg12' }))
    const contesti = h.logEvento.mock.calls.map((c) => JSON.stringify(c[2]))
    expect(contesti.join(' ')).not.toContain('abcdefg12')
    expect(contesti.join(' ')).toContain('PASSWORD_TROPPO_CORTA')
  })

  it('200 con consensi: marca onboarded_at + salva consensi_gdpr', async () => {
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(200)
    expect(h.updates[0]).toHaveProperty('onboarded_at')
    expect(h.updates[0]).toMatchObject({ consensi_gdpr: { privacy: true, termini: true } })
    expect(h.pwUpdates).toHaveLength(0)
  })

  it('registra una riga consensi_accettazioni per ogni consenso, versione SERVER-side non spoofabile', async () => {
    // Il client tenta di iniettare una versione arbitraria: deve essere IGNORATA.
    const res = await POST(req({ consensi: { privacy: true, termini: true }, versione: 'HACKED', accettato_il: '1999-01-01' }))
    expect(res.status).toBe(200)
    const termini = h.consensiInserts.find((r) => r.tipo === 'termini')
    expect(termini).toBeTruthy()
    expect(termini!.versione).toBe(VERSIONE_TERMINI)
    expect(termini!.versione).not.toBe('HACKED')
    expect(termini!.parent_id).toBe('p1')
    // Anche la privacy viene registrata.
    expect(h.consensiInserts.some((r) => r.tipo === 'privacy')).toBe(true)
  })

  it('un consenso a false non viene registrato in consensi_accettazioni', async () => {
    // termini obbligatorio → deve restare true; privacy a false blocca comunque (422),
    // quindi si testa il filtro con un consenso EXTRA facoltativo a false.
    const res = await POST(req({ consensi: { privacy: true, termini: true, marketing: false } }))
    expect(res.status).toBe(200)
    expect(h.consensiInserts.some((r) => r.tipo === 'marketing')).toBe(false)
    expect(h.consensiInserts).toHaveLength(2) // solo privacy + termini
  })

  it('il fallimento dell INSERT prova-consenso NON fa fallire l onboarding', async () => {
    h.consensiInsertErr = { code: 'PGRST205', message: 'table not found' }
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(200)
    expect((await res.json()).onboarded).toBe(true)
  })

  it('aggiorna parents per auth_user_id, MAI per id (auth.user.id è utenti.id, non parents.id — verificato in produzione: 0 genitori su 46 coincidevano, onboarding non ha mai scritto nulla)', async () => {
    await POST(req({ consensi: { privacy: true, termini: true } }))
    // ⚠️ QUESTA ASSERZIONE È STATA ALLARGATA IL 2026-09-03 E RISTRETTA LO STESSO
    // GIORNO, E VA LETTO PERCHÉ — è la storia di un lock abbassato in silenzio.
    //
    // Diceva `expect(h.eqCalls).toEqual([['auth_user_id', 'p1']])`. Da quando la
    // notifica «onboarding completato» deduce la sede dai FIGLI, la route passa
    // da `getFigliDiGenitore`, che legge il ponte con
    // `from('parents').select('id').eq('auth_user_id', accountId)`
    // (`src/lib/anagrafiche/legami.ts:83-84`): su `parents` le `.eq` diventano
    // due, ed è corretto che lo siano. L'asserzione fu quindi allargata a «ogni
    // `.eq` su `parents` è per `auth_user_id`, mai per `id`».
    //
    // Quella riscrittura ha però buttato via un invariante che il `toEqual`
    // garantiva SENZA dirlo: che l'UPDATE avesse esattamente UNA `.eq`, la
    // propria. MISURATO: togliendo `.eq('auth_user_id', auth.user.id)`
    // dall'UPDATE di `parents` — cioè riscrivendo i consensi GDPR di TUTTI i
    // genitori, senza WHERE — la suite restava verde 28 su 28, perché la `.eq`
    // del ponte riempiva l'accumulatore al posto di quella mancante.
    //
    // Adesso le due catene hanno due accumulatori (vedi l'harness) e si asserisce
    // su entrambi i fronti:
    //  · `updateEqCalls` — il WHERE dell'UPDATE c'è, ed è UNO SOLO;
    //  · `eqCalls` — nessuna `.eq` su `parents`, in nessuna catena, usa `id`.
    // Il difetto storico (0 genitori su 46 con `parents.id === utenti.id`, cioè
    // un onboarding che non scriveva mai niente) resta impossibile da ripiantare,
    // e quello nuovo — l'UPDATE senza WHERE — pure.
    expect(h.updateEqCalls).toEqual([['auth_user_id', 'p1']])
    expect(h.eqCalls.length).toBeGreaterThan(0)
    expect(h.eqCalls.map(([col]) => col)).not.toContain('id')
    for (const [col, val] of h.eqCalls) {
      expect(col).toBe('auth_user_id')
      expect(val).toBe('p1')
    }
  })

  it('404 se nessuna riga parents ha questo auth_user_id — non dichiara successo su un update che non ha aggiornato nulla', async () => {
    h.parentNotFound = true
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(404)
    expect(h.consensiInserts).toHaveLength(0)
  })

  it('500 se l update di parents fallisce (PostgREST {error}) — non dichiara successo (segnalato dal tester log C5)', async () => {
    h.parentUpdateErr = { code: '23505', message: 'conflitto inatteso' }
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBeTruthy()
    // Senza il genitore aggiornato non si registra nessuna prova di consenso:
    // altrimenti si avrebbe una riga in consensi_accettazioni senza che
    // consensi_gdpr.termini sia mai stato scritto (403 permanente in chat).
    expect(h.consensiInserts).toHaveLength(0)
  })

  it('aggiorna la password Supabase Auth se fornita e il genitore è bindato', async () => {
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: PASSWORD_VALIDA }))
    expect(res.status).toBe(200)
    expect(h.pwUpdates[0]).toMatchObject({ uid: 'auth-1' })
    // Regola 5 del logging: gli eventi critici loggano anche il SUCCESSO.
    // Senza, «nessun log» non distingue «password impostata» da «non è mai
    // partito niente» — l'ambiguità esatta che ha nascosto il guasto delle email.
    expect(esitiLoggati('info')).toContain('password-onboarding-impostata')
  })

  // ── F4: la password che il genitore ha scelto può non essere mai scritta ───
  it('GoTrue rifiuta la password ⇒ NON dichiara successo, e lascia una riga di log', async () => {
    // Il valore di ritorno di `auth.admin.updateUserById` veniva buttato via
    // (`await` e basta), mentre 20 righe sopra l'update PostgREST su `parents`
    // era controllato con tanto di commento. Se GoTrue rifiutava — policy
    // password, utente bannato, rate limit — l'onboarding rispondeva
    // `{ success: true, onboarded: true }`: il genitore aveva scelto una
    // password MAI scritta, non riusciva più ad accedere, e nei log non c'era
    // una sola riga da nessuna parte.
    h.pwErr = { name: 'AuthApiError', message: 'Password is known to be weak and easy to guess', status: 422 }

    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: PASSWORD_VALIDA }))

    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.success).toBeUndefined()
    expect(j.onboarded).toBeUndefined()
    expect(String(j.error)).toMatch(/password/i)
    expect(esitiLoggati('error')).toContain('password-onboarding-non-impostata')
    expect(esitiLoggati('info')).not.toContain('password-onboarding-impostata')
  })

  it('il rifiuto di GoTrue porta un CODICE: senza, il genitore legge «Operazione non riuscita»', async () => {
    // La pagina dell'onboarding passa da `soloCatalogoDaCorpo`, che mostra la prosa
    // del server MAI e la frase tradotta SOLO se il corpo dichiara un `codice`.
    // Questa route non ne dichiarava nessuno: quindi ogni rifiuto della password —
    // il più frequente dei quali, misurato il 04/09, è `weak_password` — arrivava
    // a schermo come il generico «Operazione non riuscita. Riprova.», che non dice
    // né che cosa è successo né che i consensi sono salvi.
    h.pwErr = { name: 'AuthApiError', message: 'boom', status: 400, code: 'validation_failed' }

    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: PASSWORD_VALIDA }))

    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.codice).toBe('PASSWORD_RIFIUTATA')
    // I consensi sono salvi, e la pagina deve poterlo dire con la PROPRIA
    // traduzione: la frase di catalogo è condivisa con l'altra route e non può
    // parlare di consensi.
    expect(j.consensi_salvati).toBe(true)
  })

  it('`weak_password` prende il proprio codice: è il rifiuto più frequente, e il rimedio è diverso', async () => {
    // Misurato il 2026-09-04 su questa stessa route: 5 occorrenze su 2 utenti, 9 su 3
    // il giorno prima. Sono password lunghe, con lettera e cifra, respinte perché
    // compaiono in elenchi di credenziali rubate ad altri siti. Dire a queste
    // persone di sceglierne una «più lunga» le manda a sbattere una seconda volta.
    h.pwErr = { name: 'AuthApiError', message: 'Password is known to be weak and easy to guess', status: 422, code: 'weak_password' }

    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: PASSWORD_VALIDA }))

    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.codice).toBe('PASSWORD_TROPPO_COMUNE')
    expect(j.consensi_salvati).toBe(true)
    // La prosa inglese del provider non esce mai dall'interfaccia.
    expect(JSON.stringify(j)).not.toContain('known to be weak')
  })

  it('un guasto del provider dichiara PASSWORD_NON_SCRITTA, non «scegline un altra»', async () => {
    h.pwErr = { name: 'AuthRetryableFetchError', message: 'service unavailable', status: 503 }
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: PASSWORD_VALIDA }))
    expect((await res.json()).codice).toBe('PASSWORD_NON_SCRITTA')
  })

  it('guasto di GoTrue (5xx) ⇒ 500, e i consensi restano salvati (l onboarding è ripetibile)', async () => {
    h.pwErr = { name: 'AuthRetryableFetchError', message: 'service unavailable', status: 503 }

    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: PASSWORD_VALIDA }))

    expect(res.status).toBe(500)
    expect((await res.json()).success).toBeUndefined()
    // I consensi erano già stati scritti: non si perdono, e il genitore può
    // ripetere l'onboarding (l'update è idempotente). Vale anche per la prova
    // d'accettazione append-only: la password è l'ULTIMO passo apposta.
    expect(h.updates[0]).toMatchObject({ consensi_gdpr: { privacy: true, termini: true } })
    expect(h.consensiInserts).toHaveLength(2)
    expect(esitiLoggati('error')).toContain('password-onboarding-non-impostata')
  })

  it('senza password non si tocca GoTrue e non si logga nessun esito password', async () => {
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(200)
    expect(h.pwUpdates).toHaveLength(0)
    expect(esitiLoggati('info')).not.toContain('password-onboarding-impostata')
    expect(esitiLoggati('error')).not.toContain('password-onboarding-non-impostata')
  })
})
