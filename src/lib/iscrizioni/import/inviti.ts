/**
 * IL REGISTRO DEGLI INVITI — un account, un invito, e nessun genitore lasciato fuori.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 * Fino al 2026-08-16 l'accesso nasceva **solo al genitore referente**: il primo
 * adulto della domanda che avesse scritto un'email. Misurato sulle 390 domande
 * arrivate: 494 adulti hanno lasciato un indirizzo, e 100 domande ne hanno DUE.
 * Cioè cento persone reali — quasi sempre l'altro genitore — sarebbero rimaste
 * fuori dall'app: niente diario, niente presenze, niente pagamenti del proprio
 * figlio. Non è un dettaglio di comodità: è metà dei genitori di cento famiglie.
 *
 * La decisione del titolare (2026-08-16) è che **ogni genitore con un'email
 * abbia il suo account**. `ensureParentIdentity` era già idempotente e già non
 * lanciava: la modifica è il CICLO, non la funzione.
 *
 * ─── DUE CLASSI DI INVITO, E NON SONO LA STESSA COSA ────────────────────────
 * · il REFERENTE è **bloccante**: se la sua email non parte, l'iscrizione non
 *   deve restare fatta a metà — si disfa tutto e la domanda torna in coda. A
 *   quel punto nessun'altra email è ancora uscita, quindi la regola è
 *   mantenibile davvero (è l'unico ordine in cui lo è);
 * · gli ALTRI genitori sono **best-effort**: quando tocca a loro l'anagrafica è
 *   già scritta e la domanda è già chiusa, quindi un loro fallimento non può
 *   disfare niente senza fare un danno più grande del guasto. La loro riga resta
 *   nel registro come `fallita`, con `tentativi` e `ultimo_errore`, e la
 *   RIPRESA (`riprendiInvitiSospesi`) ci riprova il giorno dopo.
 *
 * Senza la ripresa il secondo genitore fallito sarebbe perso per sempre: la
 * domanda è `approved`, il lotto non la ripescherebbe mai più, e nessuno
 * saprebbe che manca un accesso.
 *
 * ─── IL 429 NON È UN FALLIMENTO: È «NON OGGI» ───────────────────────────────
 * Con il tetto tirato a 90 email al giorno, il giorno in cui qualcos'altro mangia
 * la quota Resend risponde `429`. Trattarlo come un rifiuto definitivo
 * brucerebbe i tentativi di domande **buone** e le porterebbe a `bloccata`: si
 * perderebbero iscrizioni valide per un limite di quota. Quindi il 429 non
 * incrementa `tentativi`, non porta a `fallita` e ferma il giro in modo pulito.
 * Il caso peggiore diventa «il giro finisce prima e riprende domani».
 *
 * ─── `email_conflict` SU UN NON REFERENTE È UN ESITO PREVISTO ────────────────
 * Undici domande su 390 portano la STESSA casella per entrambi i genitori (3 a
 * Giugliano, 8 a Cesa). Il secondo `parents` non può legarsi allo stesso account
 * — `parents_auth_user_id_key` è UNIQUE — e la funzione risponde `email_conflict`.
 * Non è un errore da correggere: è la realtà di quella famiglia. Si logga `info`
 * e si va avanti; quella coppia condivide un accesso finché la segreteria non
 * chiede la seconda email.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami'
import { ensureParentIdentity, sedeDelGenitore } from '@/lib/auth/parent-identity'
import { rigeneraPasswordPerInvito } from '@/lib/auth/password-invito'
import { risolviContestoSede } from '@/lib/email/contesto'
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali'
import { sendEmailDetailed } from '@/lib/email/send'
import { logEvento } from '@/lib/logging/logger'
import { normalizzaEmailModulo } from '@/lib/iscrizioni/email-genitori'

/** Oltre questo numero di tentativi un invito non si ritenta più da solo. */
export const MAX_TENTATIVI_INVITO = 3

/**
 * L'esito di un singolo invito.
 *
 * `rinviata` è deliberatamente distinta da `fallita`: la prima non consuma un
 * tentativo e non è colpa della domanda, la seconda sì.
 */
export type EsitoInvito =
  | { tipo: 'inviata'; authUserId: string; messageId: string | null }
  | { tipo: 'gia_invitata'; authUserId: string }
  | { tipo: 'condivisa'; motivo: string }
  | { tipo: 'rinviata'; motivo: string }
  | { tipo: 'fallita'; motivo: string }

export interface GenitoreDaInvitare {
  parentId: string
  /** Il nome di battesimo, per l'apertura dell'email. Mai finisce nei log. */
  nome: string | null
  /** La sede dichiarata dal dato in lavorazione (quella del bambino). */
  scuolaId: string
  submissionId: string | null
}

/**
 * Che fare della riga di registro quando l'invito non parte.
 * · `ritira` — la riga si cancella: chi ha chiamato sta per disfare tutto e la
 *   domanda ripartirà da zero (è il caso del referente);
 * · `registra` — la riga resta, con il motivo e il tentativo speso, così la
 *   ripresa di domani la ritrova (è il caso degli altri genitori).
 */
export type AlFallimento = 'ritira' | 'registra'

const OPERAZIONE = 'iscrizione/import-massivo'

/**
 * La normalizzazione è UNA SOLA, e vive in `email-genitori.ts`.
 *
 * Qui serve per interrogare `email_norm` — la colonna generata `lower(btrim(email))`
 * —, lì per dire a un genitore che la sua casella è già di un altro. Sono la
 * stessa domanda, e due copie divergerebbero al primo ritocco: la divergenza si
 * vedrebbe come un modulo che rifiuta un indirizzo che l'import poi tratta come
 * nuovo, o il contrario. Il ri-export tiene i chiamanti dove sono senza duplicare
 * la regola.
 */
export { normalizzaEmailModulo as normalizzaEmail } from '@/lib/iscrizioni/email-genitori'

/**
 * Le caselle che hanno GIÀ ricevuto il loro invito.
 *
 * Si interroga `email_norm` — la colonna generata dal database — e non l'email
 * grezza: è l'unico confronto che non dipende da come l'ha scritta il chiamante.
 */
export async function emailGiaInvitate(
  supabase: SupabaseClient,
  email: readonly string[],
): Promise<Set<string>> {
  const chiavi = [...new Set(email.map(normalizzaEmailModulo).filter((e) => e.includes('@')))]
  if (chiavi.length === 0) return new Set()

  const { data, error } = await supabase
    .from('iscrizioni_inviti_credenziali')
    .select('email_norm')
    .eq('stato', 'inviata')
    .in('email_norm', chiavi)
  // PostgREST non lancia: senza questo controllo una lettura rotta si
  // travestirebbe da «nessuno è mai stato invitato», e il tetto giornaliero
  // conterebbe email che non partiranno mai — cioè si fermerebbe troppo presto.
  if (error) {
    logEvento('iscrizione', 'error', {
      operazione: OPERAZIONE,
      esito: 'registro-inviti-non-letto',
      n: chiavi.length,
      error_code: (error as { code?: string }).code ?? null,
    }, error)
    return new Set()
  }

  return new Set((data ?? []).map((r) => String((r as { email_norm: string }).email_norm)))
}

/**
 * Quante email costerebbe DAVVERO una domanda: le caselle distinte dei suoi
 * adulti, tolte quelle che hanno già ricevuto l'invito.
 *
 * È questo il numero che il tetto giornaliero deve guardare. Contare le domande
 * sarebbe un surrogato: una domanda con due genitori costa il doppio di una con
 * un genitore solo, e «48 domande» significherebbe un consumo oscillante fra 48
 * e 96 email che nessuno conosce in anticipo.
 */
export async function invitiPrevisti(
  supabase: SupabaseClient,
  email: readonly (string | null)[],
): Promise<number> {
  const distinte = [...new Set(
    email.filter((e): e is string => typeof e === 'string' && e.includes('@')).map(normalizzaEmailModulo),
  )]
  if (distinte.length === 0) return 0
  const gia = await emailGiaInvitate(supabase, distinte)
  return distinte.filter((e) => !gia.has(e)).length
}

/**
 * Crea l'accesso di UN genitore e gli manda le credenziali.
 *
 * L'ordine è quello che vale anche per il referente: prima si prende il posto
 * nel registro, poi si spedisce. `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 * con zero righe significa «questo account l'invito ce l'ha già»; un `if` che
 * legge-e-poi-scrive avrebbe una finestra, questo no.
 */
export async function invitaGenitore(
  supabase: SupabaseClient,
  genitore: GenitoreDaInvitare,
  alFallimento: AlFallimento,
): Promise<EsitoInvito> {
  const { data: parentRow, error: erroreParent } = await supabase
    .from('parents')
    .select('id, auth_user_id, emails, first_name, last_name')
    .eq('id', genitore.parentId)
    .maybeSingle()
  if (erroreParent) {
    return { tipo: 'fallita', motivo: `anagrafica del genitore non riletta: ${erroreParent.message}` }
  }

  const identita = await ensureParentIdentity(
    supabase,
    (parentRow ?? { id: genitore.parentId }) as never,
    { scuolaId: genitore.scuolaId },
  )

  if (!identita.ok) {
    if (identita.reason === 'email_conflict') {
      // I due genitori condividono la casella: previsto, misurato, e non
      // correggibile da qui. `utenti.email` è UNIQUE e GoTrue rifiuta un
      // indirizzo già registrato: non esistono due account su una casella sola.
      logEvento('iscrizione', 'info', {
        operazione: OPERAZIONE,
        esito: 'genitore-casella-condivisa',
        entita_id: genitore.parentId,
        sede_id: genitore.scuolaId,
      })
      return { tipo: 'condivisa', motivo: identita.message }
    }
    if (identita.reason === 'no_email') {
      return { tipo: 'condivisa', motivo: 'genitore senza email: nessun accesso da creare' }
    }
    return { tipo: 'fallita', motivo: `accesso del genitore non creato (${identita.reason}): ${identita.message}` }
  }

  // Il genitore ha ORA un account: i suoi legami anagrafici possono diventare
  // righe `legame_genitori_alunni`, che è la tabella letta dalle policy RLS di
  // pagamenti, mensa e chat. Vale per OGNI genitore che ottiene l'accesso, non
  // per il solo referente: senza, il secondo genitore entrerebbe e non vedrebbe
  // suo figlio — che è il modo peggiore di dargli un account.
  await sincronizzaLegamiRuntime(supabase, genitore.parentId)

  const { data: presoPosto, error: erroreClaim } = await supabase
    .from('iscrizioni_inviti_credenziali')
    .upsert(
      {
        auth_user_id: identita.authUserId,
        email: identita.email,
        parent_id: genitore.parentId,
        submission_id: genitore.submissionId,
        stato: 'da_inviare',
      },
      { onConflict: 'auth_user_id', ignoreDuplicates: true },
    )
    .select('auth_user_id')
  if (erroreClaim) {
    return { tipo: 'fallita', motivo: `registro degli inviti non scritto: ${erroreClaim.message}` }
  }
  if (!presoPosto || presoPosto.length === 0) {
    logEvento('iscrizione', 'info', {
      operazione: OPERAZIONE,
      esito: 'invito-gia-spedito',
      entita_id: identita.authUserId,
      sede_id: genitore.scuolaId,
    })
    return { tipo: 'gia_invitata', authUserId: identita.authUserId }
  }

  return spedisci(supabase, {
    authUserId: identita.authUserId,
    email: identita.email,
    nome: genitore.nome,
    scuolaId: identita.scuolaId ?? genitore.scuolaId,
    // L'account è appena nato: la password c'è. Altrimenti si rigenera — al
    // secondo tentativo `ensureParentIdentity` non la restituisce, e senza
    // questo ramo non ci sarebbe niente da mandare.
    password: identita.password,
    tentativiSpesi: 0,
    alFallimento,
  })
}

interface Spedizione {
  authUserId: string
  email: string
  nome: string | null
  scuolaId: string | null
  password: string | null
  tentativiSpesi: number
  alFallimento: AlFallimento
}

/** Spedisce l'email e aggiorna la riga del registro secondo l'esito. */
async function spedisci(supabase: SupabaseClient, s: Spedizione): Promise<EsitoInvito> {
  let password = s.password
  if (!password) {
    const rigenerata = await rigeneraPasswordPerInvito(supabase, s.authUserId, OPERAZIONE)
    if (!rigenerata.ok) {
      return registraFallimento(supabase, s, rigenerata.motivo)
    }
    password = rigenerata.password
  }

  const sede = await risolviContestoSede(supabase, s.scuolaId, OPERAZIONE)
  const messaggio = messaggioCredenziali(
    { nome: s.nome, email: s.email, password, occasione: 'iscrizione-approvata' },
    sede,
  )
  const invio = await sendEmailDetailed({
    to: s.email,
    subject: messaggio.oggetto,
    text: messaggio.testo,
    html: messaggio.html,
  })

  if (invio.ok) {
    const { error } = await supabase
      .from('iscrizioni_inviti_credenziali')
      .update({
        stato: 'inviata',
        inviato_il: new Date().toISOString(),
        resend_message_id: invio.messageId ?? null,
        ultimo_errore: null,
      })
      .eq('auth_user_id', s.authUserId)
    if (error) {
      // L'email È PARTITA e il registro non lo sa: è il caso peggiore, perché
      // domani la ripresa la rimanderebbe. Si grida, ma non si degrada l'invio a
      // fallimento — sarebbe una seconda password consegnata alla stessa persona.
      logEvento('iscrizione', 'error', {
        operazione: OPERAZIONE,
        esito: 'registro-inviti-non-aggiornato',
        entita_id: s.authUserId,
        sede_id: s.scuolaId ?? undefined,
      }, error)
    }
    logEvento('iscrizione', 'info', {
      operazione: OPERAZIONE,
      esito: 'invito-spedito',
      entita_id: s.authUserId,
      sede_id: s.scuolaId ?? undefined,
    })
    return { tipo: 'inviata', authUserId: s.authUserId, messageId: invio.messageId ?? null }
  }

  // ── IL 429: «NON OGGI», NON «NON SI PUÒ» ──────────────────────────────────
  // Non consuma un tentativo e non sporca il registro con un errore che non è
  // della domanda. La riga resta `da_inviare` e domani la ripresa la ritrova —
  // a meno che chi ha chiamato stia per disfare tutto, e allora la ritira.
  if (invio.rinviabile) {
    if (s.alFallimento === 'ritira') {
      await supabase.from('iscrizioni_inviti_credenziali').delete().eq('auth_user_id', s.authUserId)
    }
    logEvento('iscrizione', 'warn', {
      operazione: OPERAZIONE,
      esito: 'invito-rinviato-quota',
      entita_id: s.authUserId,
      sede_id: s.scuolaId ?? undefined,
      msg: `${OPERAZIONE}: quota email esaurita, il giro riprende domani`,
    })
    return { tipo: 'rinviata', motivo: invio.error ?? 'quota del provider email esaurita' }
  }

  return registraFallimento(supabase, s, invio.error ?? 'motivo sconosciuto')
}

/** Segna il fallimento sul registro — o ritira la riga, se si sta disfacendo tutto. */
async function registraFallimento(
  supabase: SupabaseClient,
  s: Spedizione,
  motivo: string,
): Promise<EsitoInvito> {
  if (s.alFallimento === 'ritira') {
    await supabase.from('iscrizioni_inviti_credenziali').delete().eq('auth_user_id', s.authUserId)
  } else {
    const { error } = await supabase
      .from('iscrizioni_inviti_credenziali')
      .update({ stato: 'fallita', tentativi: s.tentativiSpesi + 1, ultimo_errore: motivo })
      .eq('auth_user_id', s.authUserId)
    if (error) {
      logEvento('iscrizione', 'error', {
        operazione: OPERAZIONE,
        esito: 'registro-inviti-non-aggiornato',
        entita_id: s.authUserId,
      }, error)
    }
  }

  logEvento('iscrizione', 'error', {
    operazione: OPERAZIONE,
    esito: 'invito-non-spedito',
    entita_id: s.authUserId,
    sede_id: s.scuolaId ?? undefined,
    n: s.tentativiSpesi + 1,
  }, new Error(motivo))
  return { tipo: 'fallita', motivo }
}

export interface EsitoRipresa {
  /** Email uscite davvero: è ciò che consuma il tetto giornaliero. */
  spedite: number
  fallite: number
  /** Il giro si è fermato perché il provider ha detto «non oggi». */
  rinviata: boolean
}

/**
 * LA RIPRESA — gli inviti rimasti indietro, prima di cominciarne di nuovi.
 *
 * Senza di lei un secondo genitore fallito è perso per sempre: la sua domanda è
 * già `approved`, il lotto non la ripescherà mai più, e nessuno saprebbe che
 * quella persona non ha mai ricevuto le sue credenziali. Gira all'INIZIO di ogni
 * giro, perché chi aspetta da ieri viene prima di chi arriva oggi.
 *
 * @param massimo quante email può ancora spendere questo giro.
 */
export async function riprendiInvitiSospesi(
  supabase: SupabaseClient,
  massimo: number,
): Promise<EsitoRipresa> {
  const esito: EsitoRipresa = { spedite: 0, fallite: 0, rinviata: false }
  if (massimo <= 0) return esito

  const { data, error } = await supabase
    .from('iscrizioni_inviti_credenziali')
    .select('auth_user_id, email, parent_id, tentativi, stato')
    .in('stato', ['da_inviare', 'fallita'])
    .lt('tentativi', MAX_TENTATIVI_INVITO)
    .order('creato_il', { ascending: true })
    .limit(massimo)
  if (error) {
    logEvento('iscrizione', 'error', {
      operazione: OPERAZIONE,
      esito: 'ripresa-inviti-non-letta',
      error_code: (error as { code?: string }).code ?? null,
    }, error)
    return esito
  }

  const righe = (data ?? []) as {
    auth_user_id: string
    email: string
    parent_id: string | null
    tentativi: number
  }[]
  if (righe.length === 0) return esito

  logEvento('iscrizione', 'info', {
    operazione: OPERAZIONE,
    esito: 'ripresa-inviti-avviata',
    n: righe.length,
  })

  for (const riga of righe) {
    if (esito.spedite >= massimo) break

    // Il nome e la sede si rileggono dall'anagrafica: la riga del registro porta
    // solo l'indirizzo, e un'email che apre con il nome sbagliato è peggio di
    // una che non apre con nessun nome.
    let nome: string | null = null
    let scuolaId: string | null = null
    if (riga.parent_id) {
      const { data: p } = await supabase
        .from('parents')
        .select('first_name')
        .eq('id', riga.parent_id)
        .maybeSingle()
      nome = (p as { first_name?: string | null } | null)?.first_name ?? null
      scuolaId = (await sedeDelGenitore(supabase, riga.parent_id)).scuolaId
    }

    const spedito = await spedisci(supabase, {
      authUserId: riga.auth_user_id,
      email: riga.email,
      nome,
      scuolaId,
      // Al secondo giro l'account esiste già: la password si rigenera sempre.
      password: null,
      tentativiSpesi: riga.tentativi,
      alFallimento: 'registra',
    })

    if (spedito.tipo === 'inviata') esito.spedite++
    else if (spedito.tipo === 'rinviata') {
      esito.rinviata = true
      break
    } else esito.fallite++

    // Lo stesso passo del digest: ~2 al secondo, che è il limite del provider.
    await new Promise((r) => setTimeout(r, 550))
  }

  return esito
}
