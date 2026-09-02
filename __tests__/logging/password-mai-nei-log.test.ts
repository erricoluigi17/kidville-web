import { describe, it, expect, vi, beforeEach } from 'vitest'
import { conContesto, contesto } from '@/lib/logging/context'
import { redactInput } from '@/lib/logging/redact'
import { rigaEvento } from '@/lib/logging/logger'

/**
 * LE PASSWORD NON FINISCONO NEI LOG — e il punto in cui potevano finirci.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IL PUNTO, uno solo, ed è `parseBody`.
 *
 * `parseBody` fa `impostaPayload('body', raw)` **prima** di zod (`src/lib/validation/http.ts:119`,
 * e il perché è scritto lì: il payload che interessa davvero è quello che zod ha
 * RIFIUTATO). Quindi il corpo GREZZO di `POST /api/account/password` — che contiene
 * due password in chiaro — passa da `redact()` e si deposita nel contesto. Da lì
 * `withRoute` lo manda in `app_log` ogni volta che la richiesta fallisce con un 400 da
 * un utente AUTENTICATO (`with-route.ts`, politica dei livelli: «400 da AUTENTICATO →
 * warn + TABELLA») — cioè per trenta giorni, interrogabile in SQL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ LA REDAZIONE DA SOLA NON BASTA, ed è una MISURA, non un sospetto.
 *
 * `attuale` e `nuova` non contengono nessuna delle `RADICI_SEGRETE` (`password`,
 * `token`, `otp`…) e non sono in `CHIAVI_IN_CHIARO`: cadono quindi nel ramo generico
 * delle stringhe, che è `redigiStringa` → **`[redatto:str/N]`, dove N è la LUNGHEZZA**.
 * Il primo test qui sotto lo misura invece di darlo per scontato.
 *
 * La password non esce, ma la sua LUNGHEZZA sì — per l'attuale e per la nuova, di
 * ogni persona che sbaglia a compilare il modulo. Su un archivio di 560 account è
 * un aiuto gratuito a chiunque legga quella tabella: dimezza lo spazio da provare, e
 * lo fa proprio sul campo che la sicurezza del sistema regge.
 *
 * PERCIÒ la route sostituisce lo slot SUBITO dopo `parseBody`, in ENTRAMBI i rami
 * (`impostaPayloadEsito('body', 'password-non-loggata')`): al posto del corpo redatto
 * resta un marcatore scritto da noi, che dice «il corpo c'era e non lo si registra» —
 * la distinzione che `parseBody` fa già per il corpo malformato, applicata qui alla
 * ragione opposta.
 *
 * La correzione NON è stata fatta allargando `redact()`: rinominare i campi in
 * `passwordAttuale`/`passwordNuova` avrebbe fatto scattare la radice segreta, ma la
 * forma del corpo è un contratto con la schermata, e una difesa che dipende da come
 * si chiama un campo si perde al primo rinomino. Qui la difesa sta nella route, che
 * è l'unica a sapere che quel corpo è fatto di password.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
/** Lunghezze DIVERSE e riconoscibili: è la lunghezza che si vuole veder sparire. */
const ATTUALE = 'VecchiaPass1' // 12
const NUOVA = 'NuovaPassword9' // 14

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(() => Promise.resolve({ data: { session: { access_token: 'tok' } } })),
  signIn: vi.fn(),
  updateUserById: vi.fn(),
  fromSpy: vi.fn(() => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.maybeSingle = () => Promise.resolve({ data: null, error: null })
    qb.upsert = () => Promise.resolve({ error: null })
    return qb
  }),
  rateLimit: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: h.getUser, getSession: h.getSession } }),
  createAdminClient: async () => ({
    from: h.fromSpy,
    auth: { admin: { updateUserById: h.updateUserById, signOut: vi.fn() } },
  }),
  createVerificaClient: async () => ({ auth: { signInWithPassword: h.signIn } }),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: h.rateLimit,
  clientIp: () => '203.0.113.7',
}))

import { POST } from '@/app/api/account/password/route'

function req(body: unknown) {
  return new Request('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Esegue la route DENTRO un contesto nostro e restituisce ciò che vi resta depositato. */
async function esegui(body: unknown): Promise<{ stato: number; payload: unknown }> {
  // `withRoute` RIUSA il contesto già aperto invece di aprirne un secondo
  // (`with-route.ts`, blocco «Rientranza»): è questo che rende osservabile da qui il
  // payload che la route deposita.
  return conContesto({ requestId: 'r-test', path: '/api/account/password' }, async () => {
    const res = await POST(req(body) as never)
    return { stato: res.status, payload: contesto()?.payload }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getUser.mockResolvedValue({ data: { user: { id: UID, email: 'mario.rossi@example.test' } }, error: null })
  h.signIn.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  h.updateUserById.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  h.rateLimit.mockResolvedValue({ ok: true, remaining: 4, retryAfterMs: 0 })
})

describe('la redazione da sola LASCIA PASSARE la lunghezza (misura, non ipotesi)', () => {
  it('`attuale` e `nuova` escono da `redactInput` come `[redatto:str/N]`', () => {
    // Se un domani `redact()` cambiasse e questi due campi uscissero in chiaro, o al
    // contrario diventassero `[redatto]` secco, questa misura lo direbbe subito — ed è
    // la premessa su cui poggia la difesa che i test qui sotto verificano.
    expect(redactInput({ attuale: ATTUALE, nuova: NUOVA })).toEqual({
      attuale: '[redatto:str/12]',
      nuova: '[redatto:str/14]',
    })
  })

  it('la password stessa non esce mai in chiaro (la lista bianca regge)', () => {
    expect(JSON.stringify(redactInput({ attuale: ATTUALE, nuova: NUOVA }))).not.toContain(ATTUALE)
  })
})

describe('POST /api/account/password — nel contesto non resta né la password né la sua lunghezza', () => {
  it('percorso FELICE: al posto del corpo c’è il marcatore', async () => {
    const { stato, payload } = await esegui({ attuale: ATTUALE, nuova: NUOVA })

    expect(stato).toBe(200)
    expect(payload).toMatchObject({ body: { esito: 'password-non-loggata' } })
  })

  it('400 di ZOD: è il caso che finisce in TABELLA, ed è pulito anche lì', async () => {
    // `nuova` oltre i 200 caratteri: zod rifiuta, `withRoute` persiste il 400 di un
    // utente autenticato CON il payload. È l'unico percorso in cui il corpo grezzo
    // sarebbe sopravvissuto trenta giorni.
    const { stato, payload } = await esegui({ attuale: ATTUALE, nuova: 'x'.repeat(400) })

    expect(stato).toBe(400)
    const serializzato = JSON.stringify(payload)
    expect(serializzato).not.toContain(ATTUALE)
    expect(serializzato, 'la LUNGHEZZA della password attuale è ancora nel contesto')
      .not.toContain('str/12')
    expect(serializzato, 'la lunghezza della password rifiutata è ancora nel contesto')
      .not.toContain('str/400')
    expect(payload).toMatchObject({ body: { esito: 'password-non-loggata' } })
  })

  it('400 della REGOLA (password corta): nessuna lunghezza nel contesto', async () => {
    const { stato, payload } = await esegui({ attuale: ATTUALE, nuova: 'corta1' })
    expect(stato).toBe(400)
    const serializzato = JSON.stringify(payload)
    expect(serializzato).not.toContain('str/6')
    expect(serializzato).not.toContain('str/12')
  })

  it('429: anche il rifiuto per frequenza va in tabella, e non porta niente', async () => {
    h.rateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, retryAfterMs: 60_000 })
    const { stato, payload } = await esegui({ attuale: ATTUALE, nuova: NUOVA })
    expect(stato).toBe(429)
    expect(JSON.stringify(payload)).not.toContain('str/14')
  })

  it("l'EMAIL della sessione non entra nel contesto (né in chiaro né hashata dal payload)", async () => {
    const { payload } = await esegui({ attuale: ATTUALE, nuova: NUOVA })
    expect(JSON.stringify(payload)).not.toContain('mario.rossi')
    expect(JSON.stringify(payload)).not.toContain('example.test')
  })
})

describe('la riga che va in `app_log` porta solo metadati', () => {
  it("il successo `credenziali`/`info` non nomina password, email né lunghezze", () => {
    // Sono i campi ESATTI che la route passa a `logEvento` sul percorso felice.
    const riga = rigaEvento('credenziali', 'info', {
      operazione: 'account/password:POST',
      esito: 'password-cambiata',
      tipo: 'self-service',
      entita_id: UID,
      n: 1,
    })

    expect(riga?.messaggio).toBe('password-cambiata')
    const serializzata = JSON.stringify(riga)
    expect(serializzata).not.toContain(ATTUALE)
    expect(serializzata).not.toContain(NUOVA)
    expect(serializzata).not.toContain('mario.rossi')
    // L'uuid resta in chiaro per FORMA: è ciò che rende la riga attribuibile a un
    // account senza dire chi è quella persona.
    expect(serializzata).toContain(UID)
    // E i metadati sopravvivono davvero alla lista bianca: una riga tutta redatta non
    // servirebbe a nessuno, ed è metà del valore di questo log.
    const campi = (riga?.contestoExtra as { campi?: Record<string, unknown> } | undefined)?.campi
    expect(campi).toMatchObject({
      operazione: 'account/password:POST',
      esito: 'password-cambiata',
      tipo: 'self-service',
    })
  })

  it('CONTROLLO NEGATIVO: se qualcuno passasse la password come campo, verrebbe redatta', () => {
    // Non è la forma che la route usa — è la prova che la rete sotto c'è. Se questa
    // asserzione cadesse, la lista bianca avrebbe smesso di essere tale.
    // ⚠️ E il compilatore NON lo impedisce: `Record<string, Valore>` accetta qualunque
    // stringa sotto qualunque chiave. Il contratto «`campi` non accetta dati personali»
    // (logger.ts) è affidato alla disciplina di 239 chiamanti — per questo la rete
    // sotto, cioè la lista bianca di `redact()`, deve reggere davvero.
    const riga = rigaEvento('credenziali', 'info', {
      operazione: 'account/password:POST',
      esito: 'password-cambiata',
      nuova: NUOVA,
    })
    expect(JSON.stringify(riga)).not.toContain(NUOVA)
  })
})
