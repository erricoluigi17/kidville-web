import { externalFetch } from '@/lib/logging/external'
import { logEvento } from '@/lib/logging/logger'
import { hashCorrelabile } from '@/lib/logging/redact'

/**
 * Util email condiviso.
 *
 * Usa Resend se `RESEND_API_KEY` è configurato, altrimenti degrada a un esito negativo
 * PARLANTE. Mittente di default sovrascrivibile con `OTP_FROM_EMAIL`.
 *
 * ⚠️ DELIVERABILITY: il dominio di invio verificato su Resend è il SOTTODOMINIO
 * `mail.kidville.it` (verificato il 2026-07-13; l'account Resend è quello personale del
 * titolare — l'indirizzo sta nel suo gestore di credenziali e NON in questo repo, che è
 * pubblico; region eu-west-1) — NON il dominio radice `kidville.it`. In produzione va impostata
 * `OTP_FROM_EMAIL="Kidville <noreply@mail.kidville.it>"`: il mittente DEVE stare su
 * `@mail.kidville.it`, altrimenti Resend rifiuta con 403. Se la var manca si degrada al
 * mittente sandbox `onboarding@resend.dev`, che Resend CONSEGNA SOLO all'indirizzo del
 * titolare dell'account — ogni altro destinatario è rifiutato con 403.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * QUESTO FILE È LA SCENA DEL DELITTO. Per mesi nessuna email di credenziali è arrivata a
 * un genitore: Resend rispondeva 403 «the kidville.it domain is not verified», nessun test
 * era rosso e nessuno se n'è accorto. Le tre regole che escono da lì, e che qui valgono:
 *
 *  1. il CORPO del rifiuto non si butta via → la chiamata passa da `externalFetch`, che lo
 *     legge, lo logga nella colonna `app_log.messaggio` e lo propaga nell'esito;
 *  2. il SUCCESSO si logga → `evento: 'email'` è in `EVENTI_PERSISTITI`, quindi la riga di
 *     `externalFetch` finisce in tabella anche quando l'invio riesce. È il battito: con i
 *     soli errori, «nessun log» non distingue «tutte partite» da «non è mai partito niente»,
 *     ed è ESATTAMENTE l'ambiguità che ha tenuto nascosto il guasto;
 *  3. configurazione mancante = livello `error`, mai `info`. Una `RESEND_API_KEY` assente in
 *     produzione è un incidente muto: zero email, zero errori, zero sospetti.
 *
 * E il destinatario non compare MAI in chiaro nei log: solo `hashCorrelabile` (che senza
 * `LOG_HASH_SALT` è fail-closed e non produce nulla di leggibile).
 * ─────────────────────────────────────────────────────────────────────────────────
 */

export interface SendEmailParams {
  /**
   * Il destinatario, o PIÙ destinatari come elenco.
   *
   * ⚠️ NON si passa mai una stringa sola con dentro più indirizzi separati da
   * virgola. Resend la rifiuta con `422 validation_error` — «Invalid `to` field.
   * The email address needs to follow the `[email]` or `Name <[email]>` format»
   * — e non è un dettaglio di formato: è successo in produzione il 2026-08-20,
   * commit `2e505bd`, alle 11:02 e alle 11:04. Le due candidature rivolte a due
   * plessi che erano arrivate quel giorno non sono state recapitate a nessuna
   * casella di sede, mentre quelle a una sede sola passavano.
   *
   * Il tipo era `string`, il finto dei test accettava qualunque cosa, e undici
   * test sulla copia alla sede erano verdi. **Un finto più permissivo del
   * servizio vero non verifica: autorizza.** Perciò l'elenco è un `string[]`
   * nel tipo — il compilatore, non la buona volontà — e
   * `__tests__/lib/email-send-destinatari.test.ts` monta un finto che RIFIUTA
   * la virgola come fa Resend.
   */
  to: string | string[]
  subject: string
  text: string
  /**
   * Corpo HTML opzionale (additivo). Se presente, Resend lo usa come parte
   * `html` MULTIPART: `text` resta il fallback per i client senza HTML. Nessun
   * chiamante esistente lo passa → comportamento invariato. Usato dal digest News.
   */
  html?: string
  /**
   * Allegati, additivo. Resend li vuole in **base64** dentro `content`, e chiama
   * `content_type` ciò che qui si chiama `contentType`: la traduzione avviene nel
   * corpo della richiesta, sotto, perché il resto dell'applicazione non deve
   * conoscere il vocabolario del provider — il giorno in cui si cambia provider,
   * cambia un file solo.
   *
   * ⚠️ Il tetto di Resend è 40 MB per messaggio, e in base64 un file cresce di
   * circa un terzo. Chi allega un curriculum sta sotto i 4 MB — è il limite del
   * corpo di una funzione Vercel, non del bucket — quindi c'è margine; chi
   * allegasse altro faccia il conto prima, perché il rifiuto arriva dal provider
   * e non da qui.
   *
   * ⚠️ Il NOME dell'allegato è ciò che finisce nella casella di chi riceve. Non
   * ci si mette mai un percorso interno né un identificativo tecnico: `cv_path`,
   * per esempio, è la chiave di un gate (`candidature_insegnanti_cv_unico`) e non
   * ha nessun motivo di comparire in una casella di posta.
   */
  attachments?: { filename: string; content: string; contentType?: string }[]
  /**
   * A chi risponde chi riceve, quando è diverso dal mittente.
   *
   * Il mittente DEVE restare su `@mail.kidville.it` — Resend rifiuta con 403 tutto
   * il resto, ed è la scena del delitto descritta in testa a questo file — quindi
   * l'indirizzo di chi si è candidato non può essere il `from`. Senza `reply_to`
   * la sede dovrebbe ricopiarselo a mano dal corpo del messaggio, e chi ricopia un
   * indirizzo a mano prima o poi sbaglia una lettera: la risposta non arriva, e
   * nessuno dei due sa perché.
   */
  replyTo?: string
}

export interface SendEmailResult {
  ok: boolean
  /** Motivo del fallimento, già leggibile (per warning UI/audit). Null se ok. */
  error: string | null
  /**
   * L'identificativo che Resend assegna al messaggio quando lo accetta.
   *
   * Serve a rispondere, fra sei mesi, alla sola domanda che conta davvero
   * quando una famiglia dice «non mi è mai arrivata niente»: quel messaggio è
   * stato consegnato al provider, sì o no, e con che numero. Senza, l'unica
   * risposta possibile è «il nostro log dice che è partita», che è esattamente
   * ciò che si diceva anche quando NON partiva nulla.
   *
   * `null` — e non un errore — quando l'invio è riuscito ma l'id non si è
   * potuto leggere: un invio andato a buon fine non diventa un fallimento
   * perché la ricevuta era illeggibile.
   */
  messageId?: string | null
  /**
   * «NON OGGI», che è un'altra cosa da «non si può».
   *
   * Vero quando il provider ha rifiutato per QUOTA (`429`), cioè per una
   * condizione che passa da sola col tempo e che non dice niente sul
   * destinatario né sul messaggio. Chi manda in blocco deve poterli distinguere:
   * un rifiuto definitivo si registra come fallimento e consuma un tentativo, un
   * `429` **rinvia** — altrimenti il giorno in cui la quota si esaurisce si
   * marcherebbero rotte delle iscrizioni perfettamente buone, e dopo tre giorni
   * così diventerebbero «bloccate» per un limite di piano.
   *
   * Il rifiuto per quota resta comunque `ok: false`: quell'email non è partita.
   * Chi non guarda questo campo si comporta esattamente come prima.
   */
  rinviabile?: boolean
}

/**
 * Lo status con cui Resend dice «troppe richieste».
 *
 * È l'unico che si tratta come rinviabile, e la ristrettezza è voluta: un `503`
 * o un errore di rete possono essere transitori tanto quanto un `429`, ma
 * possono anche essere una configurazione rotta che nessuna attesa sistema. Il
 * `429` invece ha un solo significato, ed è scritto nel protocollo.
 */
const QUOTA_ESAURITA = 429

/**
 * Il campo `to` nella forma che Resend accetta: **sempre un elenco**.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ NON SI LIMITA A FIDARSI DEL TIPO ────────────────
 * Il tipo di `SendEmailParams.to` ora vieta la stringa-con-virgole, ma un tipo
 * protegge solo chi compila. Questa funzione è la rete sotto: se qualcuno
 * rimette un `join(', ')` — o arriva da JavaScript non tipato — l'email PARTE
 * lo stesso, verso tutti gli indirizzi che il chiamante intendeva, invece di
 * fallire con un 422 che nessuno guarda.
 *
 * E **non tace**: quella riga è un `warn`, perché è un difetto del chiamante
 * che va corretto, non una forma alternativa legittima. Silenzio qui vorrebbe
 * dire che il bug del 2026-08-20 può tornare e sopravvivere.
 *
 * ⚠️ La virgola si separa SOLO quando non c'è `<`: nella forma
 * `Nome Cognome <indirizzo@dominio>` una virgola può stare dentro il nome
 * («Rossi, Maria <m@x.it>») e spezzarla produrrebbe due destinatari inesistenti
 * — cioè trasformerebbe un invio riuscito in due rifiuti.
 */
export function destinatariPerIlProvider(to: string | string[]): string[] {
  if (Array.isArray(to)) return to
  if (to.includes(',') && !to.includes('<')) {
    const pezzi = to.split(',').map((s) => s.trim()).filter((s) => s !== '')
    logEvento('email', 'warn', {
      operazione: 'sendEmail',
      esito: 'destinatari-in-una-stringa-sola',
      n_destinatari: pezzi.length,
      // `msg` non è in lista bianca nel jsonb, ma `testoEvento()` lo promuove alla
      // colonna `app_log.messaggio`, che è in chiaro: è lì che si legge.
      msg: 'più indirizzi passati come UNA stringa separata da virgole: Resend la rifiuta con 422, sono stati separati qui. Il chiamante va corretto per passare un elenco',
    })
    return pezzi
  }
  return [to]
}

const DEFAULT_FROM = 'Kidville <onboarding@resend.dev>'

/**
 * Invia un'email e riporta l'ESITO CON MOTIVO. Il corpo dell'errore Resend
 * viene letto e propagato: un rifiuto (es. sandbox: "solo verso il proprio
 * indirizzo") non deve mai ridursi a un generico "non inviata".
 */
export async function sendEmailDetailed({ to, subject, text, html, attachments, replyTo }: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    // `error`, non `info`: senza chiave NESSUNA email parte, e in produzione è un incidente.
    // Il vecchio `console.log` stampava anche `text` in chiaro — cioè, sulle credenziali,
    // «Password temporanea: …» dritta nei Runtime Logs. Quella stampa è morta qui.
    logEvento('config', 'error', {
      operazione: 'sendEmail',
      // `msg` non è in lista bianca (nel jsonb resta redatto), ma `testoEvento()` lo promuove
      // alla colonna `app_log.messaggio`, che è in chiaro e sanificata: è lì che si legge.
      msg: 'RESEND_API_KEY assente: nessuna email può partire da questo ambiente',
    })
    return { ok: false, error: 'provider email non configurato (RESEND_API_KEY assente)' }
  }

  const esito = await externalFetch(
    'resend',
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL ?? DEFAULT_FROM,
        to: destinatariPerIlProvider(to),
        subject,
        text,
        ...(html ? { html } : {}),
        // `?.length` e non la sola presenza: un elenco VUOTO significa «non ho
        // allegati», e mandare `attachments: []` a Resend è dire una cosa diversa
        // dal non dirla. Le due forme si equivalgono oggi; il contratto di un
        // provider esterno non è una cosa su cui si scommette.
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                ...(a.contentType ? { content_type: a.contentType } : {}),
              })),
            }
          : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    },
    {
      // Il battito (successo E rifiuto) lo emette `externalFetch`: una riga sola, con il corpo
      // del provider nella colonna `messaggio`. Non se ne aggiunge una seconda qui.
      evento: 'email',
      campi: {
        operazione: 'sendEmail',
        // Hash, mai l'indirizzo. `destinatario` NON è in lista bianca, quindi in `app_log`
        // resta `[redatto:str/9]`: l'hash si legge solo su Vercel. È il prezzo accettato —
        // l'alternativa sarebbe allargare la lista bianca di `redact` a un campo che porta
        // identità, e quella lista difende dati di minori (AGENTS, regola 8).
        destinatario: hashCorrelabile(to),
      },
    }
  )

  if (esito.ok) {
    // `externalFetch` restituisce la Response col corpo INTATTO proprio perché
    // chi chiama possa leggerselo (src/lib/logging/external.ts:170-176). Fino al
    // 2026-08-16 qui la si buttava via, e con lei l'unica prova d'invio esistente.
    //
    // Il `catch` NON è muto e non è nemmeno un errore: è il caso in cui il
    // messaggio è PARTITO ma la ricevuta non si è potuta leggere (corpo già
    // consumato, JSON inatteso, campo assente). Si logga a `info` col perché —
    // AGENTS regola 6 — e si va avanti, perché degradare un invio riuscito a
    // fallito farebbe rispedire l'email: il danno sarebbe peggiore del sintomo.
    let messageId: string | null = null
    try {
      const corpo = (await esito.res?.json()) as { id?: unknown } | undefined
      messageId = typeof corpo?.id === 'string' ? corpo.id : null
    } catch (err) {
      logEvento(
        'email',
        'info',
        {
          operazione: 'sendEmail',
          esito: 'id-messaggio-non-letto',
          msg: 'email accettata dal provider, ricevuta non leggibile: l\'invio resta valido',
        },
        err,
      )
    }
    return { ok: true, error: null, messageId }
  }

  // `stato: 0` = una risposta non c'è stata affatto (rete giù, DNS, TLS).
  if (esito.stato === 0) {
    return { ok: false, error: `errore di rete verso il provider email: ${esito.corpo}` }
  }

  // Il motivo del rifiuto arriva fino a chi ha chiesto l'invio (audit, avviso in UI): un 403
  // che dice solo «403» è ciò che ha nascosto il guasto per mesi.
  const dettaglio = messaggioDelProvider(esito.corpo)

  if (esito.stato === QUOTA_ESAURITA) {
    // Livello `warn` e non `error`: non è un guasto, è il tetto del piano che si
    // è fatto sentire. Ma resta scritto — il giorno in cui il giro delle
    // iscrizioni finisce prima del previsto, questa riga è l'unica che lo spiega.
    logEvento('email', 'warn', {
      operazione: 'sendEmail',
      esito: 'quota-esaurita',
      stato: esito.stato,
      msg: `quota del provider email esaurita (429): l'invio va rinviato, non registrato come fallito`,
    })
    return {
      ok: false,
      rinviabile: true,
      error: `quota del provider email esaurita (429)${dettaglio ? `: ${dettaglio}` : ''}`,
    }
  }

  return {
    ok: false,
    error: `rifiutato dal provider email (${esito.stato})${dettaglio ? `: ${dettaglio}` : ''}`,
  }
}

/** Resend impacchetta il motivo in `{ message }`; se non è JSON, il corpo grezzo va benissimo. */
function messaggioDelProvider(corpo: string): string {
  try {
    const v: unknown = JSON.parse(corpo)
    if (v !== null && typeof v === 'object') {
      const m = (v as { message?: unknown }).message
      if (typeof m === 'string' && m !== '') return m
    }
  } catch {
    // Non era JSON: è già il testo del provider.
  }
  return corpo
}

/** Invia un'email. Ritorna true se consegnata al provider, false in fallback/errore. */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  return (await sendEmailDetailed(params)).ok
}

/*
 * ─── QUI NON C'È PIÙ NESSUN CORPO DI EMAIL, ED È UNA SCELTA ──────────────────
 *
 * Fino al 2026-08-15 questo file ospitava anche `credentialsEmailBody`, cioè il
 * TESTO dell'email delle credenziali. Due mestieri nello stesso posto: il
 * trasporto (parlare con Resend, leggere il corpo di un rifiuto, non far mai
 * uscire il destinatario in chiaro) e la scrittura (cosa si dice a una famiglia).
 *
 * Il testo vive adesso in `@/lib/email/messaggi/`, dove ogni email è una funzione
 * pura che ritorna oggetto, HTML e gemello testuale. Questo file resta il solo a
 * conoscere Resend — ed è anche ciò che il lock `provider-esterni-osservati`
 * dichiara: `src/lib/email/send.ts` è l'unico chiamante di `api.resend.com`.
 */
