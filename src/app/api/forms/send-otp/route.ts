import { NextResponse } from 'next/server'
import { createHash, randomInt } from 'crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sendEmail } from '@/lib/email/send'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { limitaVerificaOtpOggetto } from '@/lib/security/otp-rate-limit'
import { getUserEmail, OTP_TTL_MS } from '@/lib/auth/otp-ticket'
import { requireUser, type AppUser } from '@/lib/auth/require-staff'
import { getFigliDiGenitore, getGenitoriDiAlunni } from '@/lib/anagrafiche/legami'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot, getSlots } from '@/lib/fea/slots'
import { firmaCompleta, prossimoSlot } from '@/lib/fea/firma-congiunta'
import { logFeaEvent } from '@/lib/fea/audit'
import { assertGenitoreNonSospesoSalvoEssenziale } from '@/lib/pagamenti/sospensione'
import { leggiSempreFirmabile } from '@/lib/forms/sempre-firmabile'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Id opzionale: stringa vuota trattata come assente (i guard truthy esistenti
// `if (submissionId)` / `if (!modelId)` già la trattavano così).
const zUuidOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.nullish())

// POST ha due modalità mutuamente esclusive: reinvio/2° firmatario (submissionId
// presente) oppure creazione submission (modelId + data). I campi restano
// opzionali a livello di schema; il vincolo condizionale "modelId e data
// obbligatori senza submissionId" resta nel codice (non esprimibile campo-per-campo).
const postBodySchema = z.object({
  modelId: zUuidOpzionale,
  userId: zUuid.nullish(),
  // Pass-through jsonb { field_id → valore }: nessun vincolo sul contenuto.
  data: z.unknown().optional(),
  submissionId: zUuidOpzionale,
  signerEmail: z.string().nullish(),
})

const patchBodySchema = z.object({
  submissionId: zUuid,
  // Un numero funziona identico nell'hash (`${code}`): union per non
  // restringere il comportamento. Falsy ('' / 0) → 400 come il vecchio guard.
  code: z.union([z.string(), z.number()]).refine((v) => !!v, 'code è obbligatorio'),
})

// Hash deterministico: lega il codice alla submission (sale anti-rainbow-table)
function hashOtp(submissionId: string, code: string): string {
  return createHash('sha256').update(`${submissionId}:${code}`).digest('hex')
}

/**
 * Il 500 di questa route: **loggato per intero, raccontato per niente**.
 *
 * Qui c'erano QUATTRO `NextResponse.json({ error: updErr.message })`, e
 * `error.message` di PostgREST è testo interno. Su una route che fino a oggi
 * non chiedeva nessuna identità, il destinatario di quel dettaglio era
 * chiunque: misurato il 2026-08-02, un `modelId` inesistente faceva rispondere
 * `insert or update on table "form_submissions" violates foreign key constraint
 * "form_submissions_model_id_fkey"` — nome della tabella e nome del vincolo, a
 * un anonimo. Non è una fuga di dati personali: è la mappa con cui si cerca la
 * prossima porta.
 *
 * È la forma già scritta in `src/app/api/diary/route.ts` (`erroreLettura`), qui
 * applicata ai quattro punti insieme: una regola che vale per quattro strade
 * deve vivere in un posto solo, o si corregge dove è stata segnalata e resta
 * rotta altrove. Il messaggio non si perde, cambia destinatario: `logErrore`
 * porta l'oggetto errore INTERO (`code`, `details`, `hint`), che è ciò che dice
 * PERCHÉ — e `withRoute` da solo vedrebbe soltanto «ha risposto 500».
 */
function erroreInterno(operazione: string, error: unknown): NextResponse {
  logErrore({ operazione, stato: 500, evento: 'db' }, error)
  return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 })
}

// ─── L'IDENTITÀ DEL FIRMATARIO VIENE DAL DATO REGISTRATO ─────────────────────
//
// Il difetto che questo blocco chiude, misurato il 2026-08-02 su :3100: il POST
// non verificava NESSUNA identità e accettava un `signerEmail` ARBITRARIO su
// una submission ALTRUI. Chi conosceva un `submissionId` — che non è un
// segreto: è l'id che il client del genitore riceve da `/api/parent/forms` —
// si faceva recapitare il codice all'indirizzo che voleva, poi lo consegnava
// al PATCH, e il modulo risultava firmato dal genitore. Con valore legale.
//
// Il tetto per IP che la route aveva già (8/10 min, più quello per submission
// sul PATCH) difende dal *tirare a indovinare* il codice, non dal *farselo
// mandare*: chi dirotta l'email lo conosce al primo tentativo. Il problema non
// era il NUMERO di tentativi, era CHI poteva chiederli e A QUALE INDIRIZZO
// arrivava il codice.
//
// Le due domande hanno una sola risposta: **il dato già registrato**. Chi
// firma, e dove riceve il codice, si leggono dalla submission e dai tutori
// dell'alunno — mai dal corpo della richiesta.

/** Chi tiene lo sportello firma anche per conto del genitore (moduli allo sportello). */
const RUOLI_SPORTELLO: ReadonlySet<string> = new Set(['admin', 'coordinator', 'segreteria'])

/**
 * IL rifiuto di firma: uno solo, da un punto solo.
 *
 * I due casi che lo producono — «non sei fra i firmatari di questa domanda» e
 * «stai intestando la domanda a un altro» — sono lo stesso NO, e il lock
 * `errori-con-codice.test.ts` chiede esattamente questo di ogni diniego: che la
 * frase non torni a viaggiare da sola in copie scritte a mano, perché sei copie
 * dello stesso rifiuto finiscono per dire sei cose diverse (è già successo con
 * il diniego di sede, ed è per questo che esiste `rifiutoSede()`).
 */
function rifiutoFirma(): NextResponse {
  return NextResponse.json(
    { error: 'Accesso negato: non risulti fra i firmatari di questo modulo' },
    { status: 403 }
  )
}

const NEGATO_DESTINATARIO =
  'Il codice di firma può essere inviato solo a un tutore registrato dell\'alunno'

/** `  MAMMA@X.IT ` → `mamma@x.it`. Vuota/non-stringa → `null`. */
function emailNormalizzata(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const e = v.trim().toLowerCase()
  return e.length > 0 ? e : null
}

/**
 * `parents.emails` è storicamente un array; alcune righe portano una stringa
 * sola. Restituisce le coppie `[normalizzata, com'è archiviata]`: la prima
 * serve a confrontare, la seconda è quella a cui si spedisce davvero.
 */
function emailDiValore(v: unknown): [string, string][] {
  const grezze = Array.isArray(v) ? v : [v]
  const out: [string, string][] = []
  for (const g of grezze) {
    const norm = emailNormalizzata(g)
    if (norm) out.push([norm, (g as string).trim()])
  }
  return out
}

interface FirmatariRegistrati {
  /** Account (`utenti.id`) che possono agire sulla firma: titolare + co-tutori. */
  account: Set<string>
  /** email normalizzata → email COM'È in anagrafica (è quella che si spedisce). */
  email: Map<string, string>
}

/**
 * I firmatari che il DATABASE conosce per questa submission: il genitore
 * intestatario e i tutori dei suoi figli — con account (`utenti`) e senza
 * (`parents`, perché il 2° genitore email-only è previsto da DL-031 e non
 * possiede un account).
 *
 * DEGRADAZIONE — e il verso in cui degrada, che è il punto: PostgREST NON
 * lancia, ritorna `{ error }`. Se una di queste letture fallisce (colonna
 * assente sul DB E2E non migrato → 42703, tabella non leggibile) l'insieme
 * risulta PIÙ PICCOLO, mai più grande: chi non si riesce a verificare viene
 * rifiutato, non ammesso. Un guasto di lettura non deve mai aprire una firma.
 */
async function firmatariRegistrati(
  supabase: SupabaseClient,
  titolareId: string,
): Promise<FirmatariRegistrati> {
  const account = new Set<string>([titolareId])
  const email = new Map<string, string>()

  // Unione runtime + anagrafica dei figli, poi tutti i loro tutori con account.
  const figli = await getFigliDiGenitore(supabase, titolareId)
  if (figli.length > 0) {
    const perAlunno = await getGenitoriDiAlunni(supabase, figli)
    for (const lista of perAlunno.values()) for (const a of lista) account.add(a)
  }

  const { data: utenti, error: errUtenti } = await supabase
    .from('utenti')
    .select('id, email')
    .in('id', [...account])
  if (errUtenti) {
    logEvento('fea', 'warn', {
      tipo: 'firmatari-account-non-letti', azione: 'firmatariRegistrati',
      n: account.size,
    }, errUtenti)
  }
  for (const u of (utenti ?? []) as { email?: unknown }[]) {
    const norm = emailNormalizzata(u.email)
    if (norm) email.set(norm, u.email as string)
  }

  // Tutori SENZA account: esistono solo in anagrafica, ed è il caso previsto
  // dalla firma congiunta (il 2° genitore che non ha mai fatto l'onboarding).
  if (figli.length > 0) {
    const { data: sp, error: errSp } = await supabase
      .from('student_parents')
      .select('parent_id')
      .in('student_id', figli)
    if (errSp) {
      logEvento('fea', 'warn', {
        tipo: 'firmatari-anagrafica-non-letta', azione: 'firmatariRegistrati', n: figli.length,
      }, errSp)
    }
    const parentIds = [...new Set(
      ((sp ?? []) as { parent_id?: unknown }[])
        .map((r) => r.parent_id)
        .filter((v): v is string => typeof v === 'string')
    )]
    if (parentIds.length > 0) {
      const { data: righe, error: errParents } = await supabase
        .from('parents')
        .select('id, emails')
        .in('id', parentIds)
      if (errParents) {
        logEvento('fea', 'warn', {
          tipo: 'firmatari-email-anagrafiche-non-lette', azione: 'firmatariRegistrati',
          n: parentIds.length,
        }, errParents)
      }
      for (const p of (righe ?? []) as { emails?: unknown }[]) {
        for (const [norm, archiviata] of emailDiValore(p.emails)) {
          if (!email.has(norm)) email.set(norm, archiviata)
        }
      }
    }
  }

  return { account, email }
}

/**
 * 403 se chi chiama non ha titolo sulla firma di questa submission.
 *
 * Ammessi: lo staff di sportello, l'intestatario, e i co-tutori con account
 * (la firma congiunta dal proprio dispositivo). Una submission SENZA
 * intestatario (compilazione guest) la muove solo lo staff: non esiste una
 * famiglia a cui confrontarla.
 *
 * Vive qui, in una funzione sola, perché la stessa regola serve al POST (chi
 * può CHIEDERE il codice) e al PATCH (chi può FINALIZZARE la firma). È la
 * lezione che il ciclo precedente ha pagato due volte: una regola valida per
 * due strade deve stare in un posto solo, o si corregge una strada e l'altra
 * resta aperta.
 */
async function assertTitoloSullaFirma(
  supabase: SupabaseClient,
  user: AppUser,
  sub: { id?: unknown; user_id?: unknown },
  operazione: string,
): Promise<NextResponse | null> {
  if (RUOLI_SPORTELLO.has(user.role)) return null

  const titolare = typeof sub.user_id === 'string' ? sub.user_id : null
  if (titolare === user.id) return null
  if (titolare) {
    const { account } = await firmatariRegistrati(supabase, titolare)
    if (account.has(user.id)) return null
  }

  // `warn` → finisce in tabella: un tentativo di firmare al posto di un altro
  // è un evento di sicurezza, non rumore. Solo uuid, ruolo e booleani: nessuna
  // email, nessun nome, nessun dato del minore.
  logEvento('fea', 'warn', {
    tipo: 'firma-senza-titolo', azione: operazione,
    utente: user.id, ruolo: user.role,
    submission: typeof sub.id === 'string' ? sub.id : null,
    con_intestatario: titolare !== null,
  })
  return rifiutoFirma()
}

/**
 * A quale indirizzo va il codice. Senza `signerEmail` è quello dell'intestatario
 * (il reinvio di sempre); con `signerEmail` deve essere un tutore REGISTRATO
 * dell'alunno — è il 2° firmatario di DL-031, che si prende dall'anagrafica e
 * non dal body. L'indirizzo restituito è quello archiviato, non quello scritto
 * dal client.
 */
async function risolviDestinatario(
  supabase: SupabaseClient,
  user: AppUser,
  sub: { id?: unknown; user_id?: unknown },
  signerEmail: unknown,
  operazione: string,
): Promise<{ email: string | null } | { response: NextResponse }> {
  const titolare = typeof sub.user_id === 'string' ? sub.user_id : null
  const richiesta = emailNormalizzata(signerEmail)

  if (!richiesta) {
    if (!titolare) return { email: null }
    const { data, error } = await supabase
      .from('utenti').select('email').eq('id', titolare).maybeSingle()
    if (error) {
      logEvento('fea', 'warn', {
        tipo: 'email-intestatario-non-letta', azione: operazione, utente: titolare,
      }, error)
    }
    return { email: (data as { email?: string | null } | null)?.email ?? null }
  }

  // Nessun intestatario = nessuna famiglia a cui confrontare l'indirizzo: la
  // mappa resta vuota e il destinatario viene rifiutato. Fail-closed.
  const ammesse: Map<string, string> = titolare
    ? (await firmatariRegistrati(supabase, titolare)).email
    : new Map<string, string>()
  const registrata = ammesse.get(richiesta)
  if (!registrata) {
    logEvento('fea', 'warn', {
      tipo: 'destinatario-otp-non-registrato', azione: operazione,
      utente: user.id, ruolo: user.role,
      submission: typeof sub.id === 'string' ? sub.id : null,
      n_ammesse: ammesse.size,
    })
    return { response: NextResponse.json({ error: NEGATO_DESTINATARIO }, { status: 403 }) }
  }
  return { email: registrata }
}

// m4 — salva l'hash del codice + l'orario di generazione (per il TTL 10 min in
// verifica). Degrada pulito se `otp_generato_il` non esiste (DB E2E CI non
// migrato → PGRST204/42703): riprova salvando solo l'hash.
async function salvaOtpSecret(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  submissionId: string,
  otpHash: string
): Promise<{ error: { message?: string } | null }> {
  const generatoIl = new Date().toISOString()
  let res = await supabase
    .from('form_submissions')
    .update({ otp_secret: otpHash, otp_generato_il: generatoIl })
    .eq('id', submissionId)
  if (res.error && ['PGRST204', '42703'].includes((res.error as { code?: string }).code ?? '')) {
    res = await supabase
      .from('form_submissions')
      .update({ otp_secret: otpHash })
      .eq('id', submissionId)
  }
  return { error: res.error }
}

// Invio email: usa Resend se configurato, altrimenti log server-side (modalità dev)
async function deliverOtp(email: string, code: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: 'Codice di firma elettronica — Kidville',
    text: `Il tuo codice di firma è: ${code}\n\nInseriscilo per completare la firma del modulo. Il codice è valido per pochi minuti.`,
  })
}

// ── POST: crea la submission (pending_signature) e invia l'OTP ──
export const POST = withRoute('forms/send-otp:POST', async (request: Request) => {
  try {
    // Invio OTP è abusabile (spam email) → rate-limit per IP (8 / 10 min).
    const rl = rateLimit(`send-otp:${clientIp(request)}`, { limit: 8, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste OTP. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    // IL GATE D'IDENTITÀ, che qui non c'era. Sta PRIMA di `parseBody` e prima di
    // qualunque lettura: la domanda «chi sta chiedendo un codice di firma?» non
    // ha risposte accettabili dopo che il codice è partito. Il 2° firmatario
    // senza account resta possibile (DL-031) perché la richiesta la fa comunque
    // il genitore intestatario dalla propria area — quello che sparisce è
    // l'ANONIMO che chiedeva il codice sul modulo di una famiglia qualsiasi.
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { modelId, userId, submissionId, signerEmail } = b.data
    const data = b.data.data as FormSubmissionData | undefined

    const supabase = await createAdminClient()

    // ── Reinvio OTP / 2° firmatario (DL-031) ──
    // Quando arriva un `submissionId`, NON si crea una nuova submission: si
    // (ri)genera il codice per la submission esistente e lo si invia all'email
    // indicata (reinvio = intestatario; firma congiunta = il 2° tutore).
    if (submissionId) {
      const { data: sub, error: subErr } = await supabase
        .from('form_submissions')
        .select('id, status, user_id, model_id')
        .eq('id', submissionId)
        .maybeSingle()
      // PostgREST non lancia: senza questo controllo un guasto di lettura
      // sarebbe indistinguibile da «non esiste» e uscirebbe come 404.
      if (subErr) return erroreInterno('forms/send-otp:POST', subErr)
      if (!sub) {
        return NextResponse.json({ error: 'Submission non trovata' }, { status: 404 })
      }
      if (sub.status === 'completed') {
        return NextResponse.json({ error: 'Modulo già firmato' }, { status: 409 })
      }

      // CHI può chiedere il codice: l'intestatario, i suoi co-tutori, lo sportello.
      const titoloErr = await assertTitoloSullaFirma(supabase, auth.user, sub, 'forms/send-otp:POST')
      if (titoloErr) return titoloErr

      // Sospensione moroso (finding #4): anche il REINVIO/2° firmatario è un'azione
      // di servizio. Eccezione per i moduli essenziali (sempre_firmabile).
      if (sub.user_id) {
        const sempreFirmabile = await leggiSempreFirmabile(supabase, 'form_models', sub.model_id as string)
        const sospesoErr = await assertGenitoreNonSospesoSalvoEssenziale(supabase, sub.user_id as string, { sempreFirmabile })
        if (sospesoErr) return sospesoErr
      }

      // A QUALE INDIRIZZO arriva: dall'anagrafica dei tutori, non dal body.
      const dest = await risolviDestinatario(supabase, auth.user, sub, signerEmail, 'forms/send-otp:POST')
      if ('response' in dest) return dest.response
      const email = dest.email

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const { error: updErr } = await salvaOtpSecret(supabase, submissionId, hashOtp(submissionId, code))
      if (updErr) return erroreInterno('forms/send-otp:POST', updErr)

      const sent = email ? await deliverOtp(email, code) : false
      return NextResponse.json({
        submissionId,
        email,
        sent,
        ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
      })
    }

    if (!modelId || !data) {
      return NextResponse.json(
        { error: 'modelId e data sono obbligatori' },
        { status: 400 }
      )
    }

    // L'INTESTATARIO della submission è chi ha la sessione, non chi lo scrive nel
    // body. `userId` arrivava dal client e decideva a chi attribuire il modulo E
    // a chi spedire il codice: un genitore poteva far nascere una firma a nome
    // di un altro. Allo sportello resta possibile compilare PER un genitore —
    // è un'operazione di segreteria, e ha un attore autenticato che risponde.
    if (!RUOLI_SPORTELLO.has(auth.user.role) && userId && userId !== auth.user.id) {
      logEvento('fea', 'warn', {
        tipo: 'intestatario-non-proprio', azione: 'forms/send-otp:POST',
        utente: auth.user.id, ruolo: auth.user.role,
      })
      return rifiutoFirma()
    }
    const intestatario = RUOLI_SPORTELLO.has(auth.user.role)
      ? (userId ?? auth.user.id)
      : auth.user.id

    // Snapshot consensi (DL-029): carica lo schema, valida i consensi obbligatori
    // e archivia l'evidenza legale insieme alla submission.
    //
    // La lettura del modello sta PRIMA della INSERT e il suo esito si controlla:
    // un `modelId` inesistente è un errore del CLIENT (404), e prima lo si
    // scopriva soltanto facendo sbattere la INSERT contro la foreign key — che
    // rispondeva 500 raccontando il nome del vincolo.
    const { data: model, error: modelErr } = await supabase
      .from('form_models')
      .select('schema')
      .eq('id', modelId)
      .maybeSingle()
    if (modelErr) return erroreInterno('forms/send-otp:POST', modelErr)
    if (!model) {
      return NextResponse.json({ error: 'Modulo non trovato' }, { status: 404 })
    }

    // Sospensione moroso (DL-021): un genitore con un figlio sospeso non può
    // avviare nuove firme/compilazioni di moduli (azione di servizio inibita).
    // Eccezione per i moduli essenziali (sempre_firmabile: salute/sicurezza).
    //
    // Il guard `if (userId)` che stava qui è sparito, e non per pulizia: prima
    // una richiesta SENZA `userId` saltava del tutto il controllo di sospensione
    // — bastava ometterlo. Ora l'intestatario c'è sempre, perché è la sessione.
    const sempreFirmabile = await leggiSempreFirmabile(supabase, 'form_models', modelId)
    const sospesoErr = await assertGenitoreNonSospesoSalvoEssenziale(supabase, intestatario, { sempreFirmabile })
    if (sospesoErr) return sospesoErr

    const pages = ((model?.schema as FormSchemaConfig | undefined)?.pages) ?? []
    const mancanti = consensiObbligatoriMancanti(pages, data as Record<string, unknown>)
    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Consensi obbligatori non accettati', missing: mancanti },
        { status: 400 }
      )
    }
    const consents_log = estraiConsensi(pages, data as Record<string, unknown>, new Date().toISOString())

    // 1. Crea la submission in stato pending_signature
    const { data: submission, error: insertErr } = await supabase
      .from('form_submissions')
      .insert({
        model_id: modelId,
        user_id: intestatario,
        data,
        status: 'pending_signature',
        consents_log: consents_log.length > 0 ? consents_log : null,
      })
      .select('id')
      .single()

    if (insertErr || !submission) {
      return erroreInterno('forms/send-otp:POST', insertErr ?? new Error('Creazione submission fallita'))
    }

    // 2. Recupera l'email dell'intestatario (che è chi firma)
    const { data: parent, error: emailErr } = await supabase
      .from('utenti')
      .select('email')
      .eq('id', intestatario)
      .maybeSingle()
    if (emailErr) {
      logEvento('fea', 'warn', {
        tipo: 'email-intestatario-non-letta', azione: 'forms/send-otp:POST', utente: intestatario,
      }, emailErr)
    }
    const email: string | null = parent?.email ?? null

    // 3. Genera codice a 6 cifre, salva l'hash, invia
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const otpHash = hashOtp(submission.id, code)

    const { error: updErr } = await salvaOtpSecret(supabase, submission.id, otpHash)

    if (updErr) return erroreInterno('forms/send-otp:POST', updErr)

    const sent = email ? await deliverOtp(email, code) : false

    return NextResponse.json({
      submissionId: submission.id,
      email,
      sent,
      // In dev (nessun provider email) restituiamo il codice per consentire il test.
      ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
    })
  } catch (err) {
    logErrore({ operazione: 'forms/send-otp:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// ── PATCH: verifica l'OTP e finalizza la firma (completed + signed_at) ──
export const PATCH = withRoute('forms/send-otp:PATCH', async (request: Request) => {
  try {
    // IL GATE D'IDENTITÀ, anche qui. Il PATCH è il gesto che porta la firma a
    // `completed`, scrive `signed_at` e deposita la riga in `fea_signatures`:
    // sta PRIMA del tetto per submission di proposito, così un anonimo non può
    // nemmeno consumare il budget di tentativi del bersaglio — bruciarlo
    // bloccherebbe la firma al genitore vero, che è il modo silenzioso di
    // trasformare una difesa in un disservizio.
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { submissionId } = b.data
    const code = String(b.data.code)

    // ── IL TETTO SUI TENTATIVI, che qui non c'era (2026-08-01) ──
    //
    // Il POST di questa stessa route ha un tetto per IP dal primo giorno; il PATCH
    // — quello che CONFRONTA il codice — non ne ha mai avuto uno. Sei cifre sono un
    // milione di combinazioni, e senza tetto erano tutte gratuite: chi indovina
    // porta la domanda a `completed`, con `signed_at` e la riga nel registro delle
    // firme. È una firma con valore legale.
    //
    // La chiave è il `submissionId` e non l'IP, perché l'IP chi attacca lo cambia e
    // un intero plesso dietro lo stesso NAT lo condivide: si conta il BERSAGLIO, che
    // è l'unica cosa che l'attaccante non può sostituire senza rinunciare alla firma
    // che sta cercando di forzare. Il perché per esteso è in `otp-rate-limit.ts`.
    //
    // Sta PRIMA di ogni lettura: un tentativo bloccato non deve nemmeno interrogare
    // il database, e soprattutto non deve arrivare al confronto — è quello il
    // tentativo che si sta contando.
    const tettoErr = limitaVerificaOtpOggetto(submissionId)
    if (tettoErr) return tettoErr

    const supabase = await createAdminClient()

    // m4 — si legge anche `otp_generato_il` (TTL). Degrado pulito se la colonna
    // manca sul DB E2E CI non migrato (SELECT → 42703): si riprova senza.
    const baseCols = 'id, otp_secret, status, user_id, model_id'
    let selRes = await supabase
      .from('form_submissions')
      .select(`${baseCols}, otp_generato_il`)
      .eq('id', submissionId)
      .maybeSingle()
    if (selRes.error && ['PGRST204', '42703'].includes((selRes.error as { code?: string }).code ?? '')) {
      selRes = await supabase
        .from('form_submissions')
        .select(baseCols)
        .eq('id', submissionId)
        .maybeSingle()
    }
    const { data: submission, error: fetchErr } = selRes

    if (fetchErr || !submission) {
      return NextResponse.json({ error: 'Submission non trovata' }, { status: 404 })
    }

    if (submission.status === 'completed') {
      return NextResponse.json({ error: 'Modulo già firmato' }, { status: 409 })
    }

    // CHI può finalizzare: la stessa regola del POST, dalla stessa funzione.
    // Sta prima del confronto del codice: chi non ha titolo su questa firma non
    // deve nemmeno poter sapere se il codice che ha in mano è quello giusto.
    const titoloErr = await assertTitoloSullaFirma(supabase, auth.user, submission, 'forms/send-otp:PATCH')
    if (titoloErr) return titoloErr

    // Sospensione moroso (finding #4): la finalizzazione della firma è un'azione di
    // servizio → bloccata, salvo moduli essenziali (sempre_firmabile). Prima di
    // qualunque verifica del codice, così il sospeso non può nemmeno tentare.
    if (submission.user_id) {
      const sempreFirmabile = await leggiSempreFirmabile(supabase, 'form_models', submission.model_id as string)
      const sospesoErr = await assertGenitoreNonSospesoSalvoEssenziale(supabase, submission.user_id as string, { sempreFirmabile })
      if (sospesoErr) return sospesoErr
    }

    if (!submission.otp_secret || hashOtp(submissionId, code) !== submission.otp_secret) {
      return NextResponse.json({ error: 'Codice non valido' }, { status: 400 })
    }

    // m4 — TTL 10 minuti (allineato al Sistema B). Se `otp_generato_il` è assente/null
    // (colonna non migrata o riga pregressa) si mantiene il comportamento attuale.
    const generatoIl = (submission as { otp_generato_il?: string | null }).otp_generato_il
    if (generatoIl && Date.now() - Date.parse(generatoIl) > OTP_TTL_MS) {
      return NextResponse.json({ error: 'Codice scaduto, richiedine uno nuovo' }, { status: 400 })
    }

    const signedAt = new Date().toISOString()

    // Modalità firma del modello (DL-031): single (1 firmatario) o joint (2).
    const { data: model } = await supabase
      .from('form_models')
      .select('signature_mode')
      .eq('id', submission.model_id)
      .maybeSingle()
    const mode = (model?.signature_mode as string | undefined) ?? 'single'

    // Slot già firmati → indice di QUESTO firmatario e completamento per policy.
    const slotsPrima = await getSlots(supabase, 'forms', submissionId)
    const firmatiPrima = slotsPrima.filter((s) => s.stato === 'signed').length
    const slotIndex = prossimoSlot(firmatiPrima)
    const completed = firmaCompleta(mode, firmatiPrima + 1)

    // FEA (DL-001): registra il signature_log canonico anche su questo path.
    // Identità da user_id della submission (firma congiunta: il 2° firmatario
    // può essere email-only → signerUserId null).
    const userId: string | null = submission.user_id ?? null
    const email = userId ? await getUserEmail(supabase, userId) : null
    const { ip, userAgent } = extractRequestMeta(request)
    const hash = `SHA256-${hashOtp(submissionId, code).slice(0, 32).toUpperCase()}`
    const signature_log = buildSignatureLog({
      method: 'OTP_EMAIL',
      email: email ?? 'N.D.',
      ip,
      userAgent,
      hash,
      signedAt,
    })

    // Aggiorna la submission: completa solo quando la policy è soddisfatta;
    // altrimenti resta pending_signature in attesa del prossimo firmatario.
    // signature_log (primario) impostato dal 1° firmatario (slot 0).
    const updates: Record<string, unknown> = { otp_secret: null }
    if (slotIndex === 0) updates.signature_log = signature_log
    if (completed) {
      updates.status = 'completed'
      updates.signed_at = signedAt
    }
    const { error: updErr } = await supabase
      .from('form_submissions')
      .update(updates)
      .eq('id', submissionId)

    if (updErr) return erroreInterno('forms/send-otp:PATCH', updErr)

    // Ledger slot (per-firmatario) + audit immutabile (best-effort).
    await recordSignerSlot(supabase, {
      entitaTipo: 'forms',
      entitaId: submissionId,
      slotIndex,
      completionPolicy: mode === 'joint' ? 'all-required' : 'any-one',
      signerUserId: userId,
      signatureLog: signature_log,
    })
    await logFeaEvent(supabase, {
      entitaTipo: 'forms',
      entitaId: submissionId,
      signerUserId: userId,
      email,
      evento: 'signed',
      hash,
      ip,
      userAgent,
    })

    const requiredSigners = mode === 'joint' ? 2 : 1
    return NextResponse.json({
      ok: true,
      signedAt,
      completed,
      needsMoreSigners: !completed,
      signedSlots: firmatiPrima + 1,
      requiredSigners,
    })
  } catch (err) {
    logErrore({ operazione: 'forms/send-otp:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
