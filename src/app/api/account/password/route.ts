import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient, createVerificaClient } from '@/lib/supabase/server-client'
import { requireSessioneAuth } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { impostaPayloadEsito } from '@/lib/logging/context'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { classificaRifiutoPassword, codiceProviderPerLog } from '@/lib/auth/rifiuto-provider-password'
import { clientIp, rateLimit } from '@/lib/security/rate-limit'
import {
  LUNGHEZZA_MINIMA_PASSWORD,
  valutaPasswordNuova,
  type CodiceRegolaPassword,
} from '@/lib/auth/regole-password'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * POST /api/account/password — cambiare la propria password.
 *
 * UNA ROUTE SOLA per genitori e personale: la password non è un affare di area. Le
 * due popolazioni hanno anagrafiche diverse (`parents` col ponte `auth_user_id`,
 * `utenti` la cui PK È l'uid di auth), ma il gesto è identico e la chiave è la stessa
 * — `auth.users.id`. Due route avrebbero significato due tetti, due log e due
 * verifiche da tenere allineate: la lezione è già scritta due volte in questo repo
 * (`parent-identity.ts:112`, `staff-identity.ts:336`) e ogni volta è costata un
 * guasto silenzioso.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * PERCHÉ NON SI FA DAL BROWSER CON `supabase.auth.updateUser({ password })`
 *
 * Sei ragioni, tutte verificabili nel repo — e nessuna è «per pulizia»:
 *
 *  1. `secure_password_change = false` (`supabase/config.toml:223`): GoTrue **non
 *     chiede la password attuale**. Un controllo lato client è teatro: chi chiama
 *     l'API direttamente lo salta, e con una sessione rubata (un telefono lasciato
 *     aperto) cambierebbe la password senza conoscere quella vecchia.
 *  2. `console.*` è vietato in `src/` e `src/lib/logging/client.ts`, per scelta
 *     dichiarata, NON spedisce i 4xx: un cambio fallito non lascerebbe traccia da
 *     nessuna parte.
 *  3. Le chiamate Supabase del browser non finiscono in `app_log`
 *     (`__tests__/architecture/supabase-client-strumentato.test.ts`, blocco «cosa
 *     questo lock NON copre») e non hanno un tetto di tempo.
 *  4. `rateLimit()` ha il contatore su Postgres: dal browser non esiste.
 *  5. La revoca delle altre sessioni richiede la service-role.
 *  6. L'email di notifica pure.
 *
 * Il lock che tiene ferma questa decisione è
 * `__tests__/architecture/cambio-password-un-posto-solo.test.ts`.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * ⚠️ QUESTO PASSO È, TECNICAMENTE, UN ORACOLO DI PASSWORD — e va detto, non nascosto.
 *
 * La verifica dell'attuale funziona tentando un accesso vero (`signInWithPassword`):
 * la risposta della route dice quindi, a chi la interroga, se una certa password è
 * quella giusta per un certo account. È la definizione di oracolo.
 *
 * Perché è accettabile QUI, e non lo sarebbe altrove:
 *  · per arrivarci serve già una SESSIONE VALIDA di quell'account (`requireSessioneAuth`,
 *    che l'header legacy non lo legge affatto). Chi bussa ha già dimostrato di essere
 *    quella persona: l'oracolo non gli dice niente che non possa ottenere da solo;
 *  · l'account non si sceglie: è quello della sessione. Non si può interrogare
 *    l'oracolo su un terzo, che è ciò che lo renderebbe pericoloso;
 *  · il tetto è PER UTENTE, 5 tentativi ogni 15 minuti, e scatta prima di GoTrue.
 *
 * Per la stessa ragione la password attuale sbagliata risponde **400 e non 404 né
 * un 401 generico**: qui non c'è nessuna enumerazione da impedire, e un rifiuto vago
 * manderebbe l'utente a correggere il campo sbagliato.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * ⚠️ NOTA DI SICUREZZA SUL CORPO — il solo punto in cui una password poteva finire
 * in `app_log` per trenta giorni.
 *
 * `parseBody` fa `impostaPayload('body', raw)` **prima** di zod
 * (`src/lib/validation/http.ts:119`, e la ragione è scritta lì): il corpo GREZZO passa
 * quindi da `redact()` e si deposita nel contesto, da dove `withRoute` lo manda in
 * tabella su ogni 400 di un utente autenticato.
 *
 * MISURATO, non supposto (`__tests__/logging/password-mai-nei-log.test.ts`): `attuale`
 * e `nuova` non contengono nessuna delle `RADICI_SEGRETE` di `redact.ts` e non sono in
 * `CHIAVI_IN_CHIARO`, quindi cadono nel ramo generico delle stringhe — che è
 * `[redatto:str/N]`, **con N uguale alla lunghezza**. La password non esce; la sua
 * lunghezza sì, per ogni persona che sbaglia a compilare il modulo. Su 560 account è
 * un aiuto gratuito a chiunque legga quella tabella.
 *
 * Perciò lo slot si sostituisce SUBITO dopo `parseBody`, in ENTRAMBI i rami. Non si è
 * corretto `redact()` né rinominato i campi in `passwordAttuale`/`passwordNuova` (che
 * pure farebbe scattare la radice segreta): la forma del corpo è un contratto con la
 * schermata, e una difesa che dipende da come si chiama un campo si perde al primo
 * rinomino. Qui la difesa sta dove sta la conoscenza — questa è l'unica route che sa
 * che quel corpo è fatto di password.
 */
const MARCATORE_CORPO = 'password-non-loggata'

const bodySchema = z.object({
  attuale: z.string().min(1).max(200),
  nuova: z.string().min(1).max(200),
  /**
   * Da quale porta è passato il cambio. `z.string()` e non `z.enum(...)`, e non è
   * pigrizia: è un campo di MISURA, e un campo di misura non deve poter far fallire
   * un cambio password valido. Un valore che non riconosciamo ricade su
   * `self-service` (vedi `origineValida`), così in tabella non finisce mai qualcosa
   * che il CHECK di `password_cambi` rifiuterebbe.
   */
  origine: z.string().max(40).optional(),
})

/**
 * Le due porte da cui si cambia password, e perché la distinzione conta.
 *
 * `password_cambi.origine` esiste per rispondere a una domanda sola, scritta nella
 * migrazione che crea la tabella: «se `primo-accesso` resta a 0 mentre `self-service`
 * cresce, l'instradamento non sta raggiungendo nessuno». Senza questo campo quella
 * misura non è possibile, e il lavoro sembrerebbe finito mentre è a metà.
 *
 * `onboarding` è il TERZO valore ammesso dal CHECK, ma da qui non può uscire: è il
 * vecchio flusso consensi+password di `parent/onboarding`, che ha una route sua.
 */
const ORIGINI_AMMESSE = ['primo-accesso', 'self-service'] as const
const ORIGINE_PREDEFINITA = 'self-service'

function origineValida(v: string | undefined): (typeof ORIGINI_AMMESSE)[number] {
  return ORIGINI_AMMESSE.includes(v as (typeof ORIGINI_AMMESSE)[number])
    ? (v as (typeof ORIGINI_AMMESSE)[number])
    : ORIGINE_PREDEFINITA
}

/**
 * IL TETTO, due chiavi, e l'ordine fra loro non è indifferente.
 *
 * PER UTENTE PRIMA CHE PER IP. Dietro il NAT di una sede le famiglie condividono
 * l'indirizzo — la motivazione per esteso sta già in `rate-limit.ts:415-426` — quindi
 * contare prima per IP significherebbe far scattare il tetto di una madre a causa dei
 * tentativi di un'altra, sulla stessa rete. Il tetto per utente è la difesa vera
 * (5 tentativi ogni 15 minuti su un gesto che si fa una volta l'anno); quello per IP
 * è la rete contro chi prova con molti account insieme.
 *
 * ⚠️ E DEVE SCATTARE PRIMA DI GoTrue. Il provider ha il proprio tetto su
 * `sign_in_sign_ups` (30 ogni 5 minuti per IP) e `signInWithPassword` lo consuma: se
 * il nostro fosse più largo, l'utente riceverebbe un 429 opaco del provider — inglese,
 * senza codice, non traducibile — al posto del nostro messaggio. 20 in 15 minuti sono
 * 6,67 in 5 minuti: sta sotto con margine, e c'è un test che lo misura invece di
 * fidarsi dell'aritmetica scritta qui.
 */
const FINESTRA_MS = 15 * 60 * 1000
const TETTO_PER_UTENTE = { limit: 5, windowMs: FINESTRA_MS }
const TETTO_PER_IP = { limit: 20, windowMs: FINESTRA_MS }

/**
 * I codici PostgREST che dicono «lo schema non c'è ancora», non «c'è un guasto».
 *
 * Il DB E2E della CI è un progetto separato e NON migrato: `password_cambi` lì non
 * esiste. Il codice nuovo deve degradare in modo pulito — la password È cambiata, e
 * far fallire la richiesta per una riga di misura sarebbe un guasto inventato.
 */
const SCHEMA_ASSENTE = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])

function schemaAssente(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && SCHEMA_ASSENTE.has(code)
}

/**
 * Il rifiuto di ciascuna regola: la prosa (per chi legge i log e per chi chiama l'API)
 * e il CODICE (per chi guarda lo schermo).
 *
 * QUATTRO COSTRUTTORI E NON UNA RISPOSTA SOLA, per la stessa ragione scritta in
 * `parent/onboarding/route.ts`: il `codice` va scritto come STRINGA LETTERALE, perché
 * il lock `__tests__/architecture/errori-con-codice.test.ts` legge il corpo di ogni
 * `NextResponse.json({ … })` e un `codice: mappa[x].codice` non lo saprebbe verificare
 * — né contro `CODICI_ERRORE`, né contro i due cataloghi. Un valore che il lock non sa
 * leggere è un valore che nessuno controlla.
 *
 * Il numero non è ricopiato: viene da `LUNGHEZZA_MINIMA_PASSWORD`, che è il posto in
 * cui la regola vive.
 */
const RIFIUTO_REGOLA: Record<CodiceRegolaPassword, () => NextResponse> = {
  PASSWORD_TROPPO_CORTA: () =>
    NextResponse.json(
      { error: `La password deve avere almeno ${LUNGHEZZA_MINIMA_PASSWORD} caratteri.`, codice: 'PASSWORD_TROPPO_CORTA' },
      { status: 400 },
    ),
  PASSWORD_SENZA_CIFRA: () =>
    NextResponse.json(
      { error: 'La password deve contenere almeno una lettera e almeno una cifra.', codice: 'PASSWORD_SENZA_CIFRA' },
      { status: 400 },
    ),
  PASSWORD_CON_SPAZI_AI_BORDI: () =>
    NextResponse.json(
      { error: 'La password non può iniziare o finire con uno spazio.', codice: 'PASSWORD_CON_SPAZI_AI_BORDI' },
      { status: 400 },
    ),
  PASSWORD_UGUALE_ALLA_PRECEDENTE: () =>
    NextResponse.json(
      { error: 'La nuova password deve essere diversa da quella attuale.', codice: 'PASSWORD_UGUALE_ALLA_PRECEDENTE' },
      { status: 400 },
    ),
}

/** 500 «non è stata scritta»: la password di prima resta valida, ed è la cosa da dire. */
function nonScritta(): NextResponse {
  return NextResponse.json(
    {
      error: 'Non è stato possibile salvare la nuova password: riprovare fra poco. Quella attuale resta valida.',
      codice: 'PASSWORD_NON_SCRITTA',
    },
    { status: 500 },
  )
}

export const POST = withRoute('account/password:POST', async (request: Request) => {
  // 1. IL GATE. `requireSessioneAuth`, non `requireUser`: la differenza — e il motivo
  //    per cui una route che riscrive password non può accettare `x-user-id` — è
  //    scritta per esteso sulla funzione, in `src/lib/auth/require-staff.ts`.
  const gate = await requireSessioneAuth()
  if (gate.response) return gate.response
  const { authUserId, email } = gate.sessione

  // 2. IL CORPO, e la sostituzione immediata dello slot di log (vedi MARCATORE_CORPO).
  //    `impostaPayloadEsito` sta PRIMA del `return`: il ramo che va in tabella è
  //    proprio quello del 400, e lasciarlo scoperto avrebbe vanificato la difesa.
  const b = await parseBody(request, bodySchema)
  impostaPayloadEsito('body', MARCATORE_CORPO)
  if ('response' in b) return b.response
  const { attuale, nuova } = b.data
  const origine = origineValida(b.data.origine)

  try {
    // 3. IL TETTO, per utente e poi per IP, prima di toccare GoTrue.
    for (const [chiave, tetto] of [
      [`pwd-cambio:${authUserId}`, TETTO_PER_UTENTE],
      [`pwd-cambio-ip:${clientIp(request)}`, TETTO_PER_IP],
    ] as const) {
      const rl = await rateLimit(chiave, tetto)
      if (!rl.ok) {
        // `warn` e non `info`: una raffica di tentativi di cambio password è il segnale
        // di una sessione rubata o di qualcuno che prova le password a mano, ed è
        // esattamente ciò che si vuole poter contare in SQL fra un mese. `withRoute`
        // persiste già i 429, ma la sua riga non dice QUALE dei due tetti ha ceduto —
        // e i due significano cose diverse: uno è una persona, l'altro una rete.
        logEvento('credenziali', 'warn', {
          operazione: 'account/password:POST',
          esito: 'tetto-superato',
          tipo: chiave.startsWith('pwd-cambio-ip:') ? 'per-ip' : 'per-utente',
          entita_id: authUserId,
          stato: 429,
        })
        return NextResponse.json(
          { error: 'Troppi tentativi di cambio password. Riprova fra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
        )
      }
    }

    // 4. LE REGOLE. Stanno in un posto solo (`@/lib/auth/regole-password`), che è anche
    //    quello che la schermata usa mentre si digita: il server non può dire una cosa
    //    diversa da quella che il campo ha appena promesso.
    const regola = valutaPasswordNuova(nuova, attuale)
    if (!regola.ok) {
      // `info`: non è un guasto nostro, è una password che non va bene. Va loggato lo
      // stesso, perché senza questa riga «non riesce a cambiare password» non
      // distingue una regola nostra da un rifiuto di GoTrue cento righe più in basso.
      // Esce il CODICE, mai la password (e mai la sua lunghezza).
      logEvento('credenziali', 'info', {
        operazione: 'account/password:POST',
        esito: 'password-rifiutata-dalla-regola',
        error_code: regola.codice,
        tipo: origine,
        entita_id: authUserId,
      })
      return RIFIUTO_REGOLA[regola.codice]()
    }

    // 5. LA PASSWORD ATTUALE. È il controllo che `secure_password_change = false` non
    //    fa, e senza il quale una sessione rubata basterebbe a chiudere fuori una
    //    famiglia dal proprio registro.
    if (!email) {
      // L'account non ha un indirizzo: la verifica è impossibile. Non è un 401 — chi
      // chiede è autenticato — ed è un guasto NOSTRO (in questo sistema gli account
      // nascono tutti con un'email: `createUser({ email, password })`), quindi si
      // logga come tale e si risponde che la password non è stata scritta, il che è
      // vero e dice all'utente la cosa che gli serve: quella di prima vale ancora.
      logEvento('credenziali', 'error', {
        operazione: 'account/password:POST',
        esito: 'account-senza-email',
        entita_id: authUserId,
        stato: 500,
      })
      return nonScritta()
    }

    const verifica = await createVerificaClient()
    const { error: erroreVerifica } = await verifica.auth.signInWithPassword({ email, password: attuale })
    if (erroreVerifica) {
      // Il corpo dell'errore del provider NON si butta via (AGENTS regola 3) — resta
      // nel log, ultimo argomento — e NON esce nella risposta: è prosa inglese, ed è
      // ciò che i codici d'errore hanno tolto dall'interfaccia. Livello `info` perché
      // una password sbagliata è una risposta corretta a una richiesta sbagliata; il
      // segnale d'abuso è il tetto qui sopra, che è `warn`.
      logEvento('credenziali', 'info', {
        operazione: 'account/password:POST',
        esito: 'password-attuale-errata',
        tipo: origine,
        entita_id: authUserId,
        stato: (erroreVerifica as { status?: number }).status,
      }, erroreVerifica)
      return NextResponse.json(
        { error: 'La password attuale non è corretta.', codice: 'PASSWORD_ATTUALE_ERRATA' },
        { status: 400 },
      )
    }

    // 6. LA SCRITTURA, e il suo valore di ritorno che non si butta via.
    //
    // ⚠️ EFFETTO MISURATO, non supposto (2026-09-01, sorgente di GoTrue):
    // `internal/api/admin.go` → `adminUserUpdate` chiama `user.UpdatePassword(tx, nil)`;
    // `internal/models/user.go` → con `sessionID == nil` esegue `Logout(tx, u.ID)`;
    // `internal/models/sessions.go` → `Logout` è `DELETE FROM sessions WHERE user_id = ?`.
    // Cioè questa riga revoca **tutte** le sessioni di quella persona, compresa quella
    // di chi ha appena chiesto il cambio.
    //
    // Due conseguenze, entrambe volute e nessuna delle due implicita:
    //  · non serve nessuna `auth.admin.signOut(token, 'others')` dopo: sarebbe una
    //    chiamata su una sessione che non esiste più, quindi un 4xx e un `warn`
    //    «sessioni-altrove-non-revocate» a OGNI cambio riuscito — un allarme falso
    //    permanente, cioè il rumore che rende invisibili i guasti veri;
    //  · chi ha appena cambiato la password deve rifare l'accesso su QUESTO dispositivo.
    //    La risposta lo dice (`sessioniTerminate`), perché una schermata che non lo sa
    //    mostrerebbe una sfilza di 401 al posto di «fatto, rientra».
    const admin = await createAdminClient()
    const { error: erroreScrittura } = await admin.auth.admin.updateUserById(authUserId, { password: nuova })
    if (erroreScrittura) {
      const stato = (erroreScrittura as { status?: number }).status
      // 4xx = la password non va bene (l'utente può sceglierne un'altra); tutto il
      // resto — 5xx, o un errore senza status, che in produzione si è già visto — è un
      // guasto nostro. Il messaggio di GoTrue resta nel log, mai nella risposta.
      //
      // ⚠️ I 4xx NON SONO TUTTI UGUALI, e trattarli come tali è costato 30 rifiuti
      // al giorno. Misurato il 2026-09-04 su `app_log`: `422 weak_password` —
      // password presente in elenchi di credenziali rubate — colpiva **20 utenti
      // distinti in un giorno** (29 il giorno prima), e tutti leggevano la frase di
      // `PASSWORD_RIFIUTATA`, che consiglia una password «più lunga e con almeno una
      // lettera e una cifra»: requisiti che avevano GIÀ soddisfatto, con i tre
      // criteri della schermata verdi sotto gli occhi. Un rifiuto che indica il
      // rimedio sbagliato manda a sbattere due volte.
      //
      // La classificazione sta in un modulo solo (`rifiuto-provider-password.ts`)
      // perché la stessa domanda vive anche in `parent/onboarding`, e la stessa
      // domanda posta in due posti diverge.
      const rifiuto = classificaRifiutoPassword(erroreScrittura)
      const colpaDellaPassword = rifiuto !== 'guasto'
      logEvento('credenziali', colpaDellaPassword ? 'info' : 'error', {
        operazione: 'account/password:POST',
        // L'esito distingue i due rifiuti: senza, le trenta occorrenze di una
        // giornata restano una massa indistinta e nessuno può accorgersi che
        // diciannove su venti hanno lo stesso motivo.
        esito: rifiuto === 'password-nota'
          ? 'password-nota-alle-liste'
          : colpaDellaPassword ? 'password-rifiutata-dal-provider' : 'password-non-scritta',
        tipo: origine,
        entita_id: authUserId,
        stato: typeof stato === 'number' ? stato : undefined,
        // `error_code` è un enumerato ed è già dichiarato in chiaro in `redact.ts`:
        // è la sola parte dell'errore del provider che si possa registrare così.
        // La prosa inglese resta dov'era, dentro `logEvento(..., erroreScrittura)`.
        error_code: codiceProviderPerLog(erroreScrittura),
      }, erroreScrittura)
      if (!colpaDellaPassword) return nonScritta()
      if (rifiuto === 'password-nota') {
        return NextResponse.json(
          {
            error: 'Questa password compare in elenchi di password rubate: sceglierne un\'altra.',
            codice: 'PASSWORD_TROPPO_COMUNE',
          },
          { status: 400 },
        )
      }
      return NextResponse.json(
        { error: 'Questa password non è stata accettata: sceglierne un\'altra.', codice: 'PASSWORD_RIFIUTATA' },
        { status: 400 },
      )
    }

    // 7. LA RIGA IN `password_cambi` — best-effort, ma MAI muta.
    //
    // La password è già cambiata: un guasto qui non deve far fallire la richiesta né
    // farla mentire. Si legge il conteggio precedente e si riscrive incrementato:
    // PostgREST non sa esprimere `cambi = cambi + 1` in un upsert, e una RPC per un
    // contatore di misura sarebbe una funzione in più da mantenere in produzione. Due
    // richieste ravvicinate dello stesso account possono quindi contarne una sola —
    // accettabile per un dato che serve a misurare l'adozione, non a governare accessi
    // (lo dice la migrazione che crea la tabella).
    await registraCambio(admin, authUserId, origine)

    // 8. IL SUCCESSO SI LOGGA (AGENTS regola 5). Senza questa riga «nessun log» non
    //    distingue «nessuno cambia password» da «il cambio non parte più» — l'ambiguità
    //    esatta che ha tenuto nascosto per mesi il guasto delle email di credenziali,
    //    e per giunta sullo stesso dominio.
    logEvento('credenziali', 'info', {
      operazione: 'account/password:POST',
      esito: 'password-cambiata',
      tipo: origine,
      entita_id: authUserId,
    })

    // ⚠️ TODO — L'EMAIL «la password è stata cambiata» SI AGGANCIA QUI, e non è
    // decorazione: serve a chi la password NON l'ha cambiata. È l'unico modo in cui il
    // proprietario di un account scopre che qualcun altro ci è entrato — lo dice il
    // generatore stesso, in testa al file.
    //
    // COSA C'È GIÀ (misurato il 2026-09-01, non supposto):
    //   · `messaggioPasswordCambiata(d, sede)` e `OGGETTO_PASSWORD_CAMBIATA` in
    //     `src/lib/email/messaggi/password-cambiata.ts`, con il suo test;
    //   · il modo di spedire: `sendEmailDetailed({ to, subject, html, text })`
    //     (`src/lib/email/send.ts`), che passa da `externalFetch` — quindi l'esito, in
    //     entrambi i versi, si logga da sé. Il modello esatto è
    //     `admin/regenerate-credentials/route.ts:184-196`;
    //   · la data italiana: `formattaIstante(…, 'it', …)` da `@/i18n/config`.
    //
    // COSA MANCA, ed è il motivo per cui NON si aggancia in questo passo: la SEDE.
    // `risolviContestoSede` vuole un `sedeId`, e qui in mano c'è solo un uid di auth.
    // Per il personale è `utenti.scuola_id`; per un genitore è la sede dei figli, che
    // possono essere in plessi diversi — e il generatore dichiara per iscritto che
    // «Kidville» generico NON basta («chi ha un figlio a Giugliano e insegna ad Aversa
    // ha due accessi, e deve sapere quale dei due è stato toccato»). Agganciarla al
    // ripiego senza sede farebbe partire un'email di sicurezza che non identifica
    // l'account: peggio che non mandarla, perché sembra fatta.
    //
    // Quando si aggancia: DOPO questo log e PRIMA della risposta, e senza far fallire
    // il cambio se l'invio non riesce (la password è già cambiata) — ma loggando, mai
    // `.catch(() => {})`.

    return NextResponse.json({ ok: true, sessioniTerminate: true })
  } catch (err) {
    // `withRoute` NON vede le eccezioni catturate: senza questa riga il 500 avrebbe
    // `operazione` e `stato` e nessuno stack.
    logErrore({ operazione: 'account/password:POST', stato: 500, evento: 'credenziali' }, err)
    return nonScritta()
  }
})

/**
 * Registra il cambio in `password_cambi`. Non lancia e non decide: il chiamante ha già
 * cambiato la password, e questa riga serve a MISURARE.
 *
 * La distinzione fra «la tabella non c'è» (CI non migrata) e «la scrittura è fallita»
 * vive nel campo `esito`, non nel livello: sono due fatti diversi e chi legge deve
 * poterli separare in SQL. Entrambi sono `warn` perché entrambi significano che la
 * misura di quel giorno è incompleta — ed è una cosa che si vuole sapere subito, non
 * scoprire fra un mese guardando un grafico che non torna.
 */
async function registraCambio(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  authUserId: string,
  origine: string,
): Promise<void> {
  // PostgREST non lancia: ritorna `{ error }`. Il valore di ritorno si controlla
  // sempre, anche su una scrittura che non decide niente (AGENTS regola 7).
  const { data: precedente, error: erroreLettura } = await admin
    .from('password_cambi')
    .select('cambi')
    .eq('auth_user_id', authUserId)
    .maybeSingle()

  if (erroreLettura) {
    logEvento('credenziali', 'warn', {
      operazione: 'account/password:POST',
      esito: schemaAssente(erroreLettura) ? 'password-cambi-assente' : 'password-cambi-non-letta',
      entita_id: authUserId,
    }, erroreLettura)
    // Si prosegue comunque: senza il conteggio precedente la riga vale 1, e una
    // misura che riparte da uno è meglio di nessuna misura.
  }

  const precedenti = typeof precedente?.cambi === 'number' ? precedente.cambi : 0

  const { error: erroreScrittura } = await admin.from('password_cambi').upsert(
    {
      auth_user_id: authUserId,
      cambiata_il: new Date().toISOString(),
      cambi: precedenti + 1,
      origine,
    },
    { onConflict: 'auth_user_id' },
  )

  if (erroreScrittura) {
    logEvento('credenziali', 'warn', {
      operazione: 'account/password:POST',
      esito: schemaAssente(erroreScrittura) ? 'password-cambi-assente' : 'password-cambio-non-registrato',
      tipo: origine,
      entita_id: authUserId,
    }, erroreScrittura)
  }
}
