/**
 * I tre passi che valgono come uno: l'anagrafica, l'accesso, l'invito.
 *
 * ─── L'ORDINE, E PERCHÉ È QUESTO ────────────────────────────────────────────
 *   1. ANAGRAFICA  `parents` · `alunni` (classe + retta) · `student_parents`
 *   2. ACCESSO     `ensureParentIdentity` → auth.users + `utenti` + il ponte
 *   3. INVITO      la password per email, e solo dopo aver preso il posto nel
 *                  registro degli inviti
 *   4. CHIUSURA    la domanda diventa `approved`
 *   5. GLI ALTRI GENITORI, uno per uno, a domanda già chiusa
 *
 * L'email è l'ULTIMO passo, mai il penultimo: una password consegnata non si
 * ritira, e se la scrittura fallisse dopo l'invio la famiglia si troverebbe con
 * credenziali valide e nessun figlio collegato.
 *
 * ─── PERCHÉ IL REFERENTE È PRIMO, E BLOCCANTE ───────────────────────────────
 * Dal 2026-08-16 ogni genitore con un'email ha il suo account: 494 adulti su 390
 * domande, e 100 domande ne portano DUE. Ma i due inviti non hanno lo stesso
 * peso, e l'ordine è ciò che rende la regola del titolare mantenibile.
 *
 * «Se l'email non parte, l'iscrizione NON deve restare fatta a metà» è
 * mantenibile **solo finché nessuna email è ancora uscita**. Quindi il referente
 * si serve per PRIMO: se il suo invito non parte si disfa tutto — anagrafica
 * inclusa — e la domanda torna in coda, perché a quel punto non c'è ancora
 * nessuna password consegnata a nessuno.
 *
 * Gli ALTRI genitori vengono dopo la chiusura, e sono best-effort: quando tocca
 * a loro il referente ha già in mano le sue credenziali, e disfare l'iscrizione
 * per il secondo indirizzo significherebbe togliere a una famiglia un accesso
 * che funziona. Il loro invito fallito resta scritto nel registro e la RIPRESA
 * (`riprendiInvitiSospesi`) ci riprova il giorno dopo — senza la ripresa quella
 * persona sarebbe persa per sempre, perché la domanda ormai è `approved` e il
 * lotto non la ripescherebbe mai più.
 *
 * ─── COSA SI DISFA, E COSA NO ───────────────────────────────────────────────
 * Se l'invito del referente non parte si annulla il passo 1 — e SOLO ciò che
 * questo giro ha creato, non ciò che ha trovato: un `parents` riusato per
 * deduplica del codice fiscale è di un'altra famiglia già in archivio.
 *
 * Il passo 2 non si disfa MAI. Cancellare l'account lascerebbe orfana la riga
 * `utenti` (che non ha una FK verso `auth.users`) con la sua email unica, e il
 * giorno dopo l'INSERT sbatterebbe su `utenti_email_key`: la domanda non si
 * chiuderebbe più, per sempre, con un errore che non nomina la causa. L'account
 * resta e il tentativo successivo lo riusa.
 *
 * ─── I TRE CASI CHE UCCIDEREBBERO IL DISEGNO, SE NON FOSSERO PREVISTI ───────
 * ① `ensureParentIdentity` restituisce la password SOLO quando crea l'account.
 *    Al secondo tentativo l'account esiste già, la password è `null`, e non ci
 *    sarebbe niente da mandare: l'invito resterebbe appeso finché non diventa
 *    «bloccata», col primo giro andato bene e nessun errore che lo spieghi.
 *    → se l'invito è ancora da mandare, la password si RIGENERA (`inviti.ts`).
 * ② 23 caselle email compaiono in più domande (fratelli iscritti separatamente).
 *    Il secondo `parents` non può legarsi allo stesso account — `parents_auth_user_id_key`
 *    è UNIQUE — e la funzione risponde `email_conflict`. In un lavoro automatico
 *    diventerebbe un fallimento ripetuto tre volte, mentre il requisito è
 *    l'opposto: l'alunno DEVE entrare.
 *    → `email_conflict` è un esito previsto: si aggancia il bambino al `parents`
 *      che possiede già quell'account, e l'email non riparte.
 * ③ 11 domande portano la STESSA casella per entrambi i genitori. Lì il secondo
 *    account non può nascere — `utenti.email` è UNIQUE e GoTrue rifiuta un
 *    indirizzo già registrato — e non è un guasto da correggere: è la realtà di
 *    quella famiglia, che condivide un accesso finché non arriva una seconda
 *    casella. Stesso ramo del caso ②, stesso silenzio operoso.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildParentRecord } from '@/lib/anagrafiche/parents'
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami'
import { findAuthUserIdByEmail } from '@/lib/auth/parent-identity'
import { logEvento } from '@/lib/logging/logger'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { normalizzaNome } from './normalizza'
import { invitaGenitore, normalizzaEmail } from './inviti'
import type { AssegnazioneBambino, Domanda } from './analisi'

const OPERAZIONE = 'iscrizione/import-massivo'

export interface EsitoEsecuzione {
  /**
   * `rinviata` non è `errore`: il provider ha detto «non oggi» (429), non «no».
   * Si disfa il giro senza consumare un tentativo e si riprende domani.
   */
  esito: 'inviata' | 'gia_invitata' | 'errore' | 'rinviata'
  messageId: string | null
  errore: string | null
  /**
   * Le email uscite DAVVERO da questa domanda. È il numero che consuma il tetto
   * giornaliero — non «1 per domanda», che con due genitori sarebbe una bugia.
   */
  emailSpedite: number
}

/** Il jsonb del form, che porta i campi che `Domanda` non modella. */
type DatiGrezzi = { children?: unknown[]; adults?: unknown[] } & Record<string, unknown>

function campo(o: unknown, chiave: string): string | null {
  const v = (o as Record<string, unknown> | null)?.[chiave]
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

/** Trova un `parents` per codice fiscale, oppure lo crea. */
async function parentDiRiferimento(
  supabase: SupabaseClient,
  grezzo: unknown,
  submissionId: string,
): Promise<{ id: string; creato: boolean } | { errore: string }> {
  const cf = campo(grezzo, 'fiscal_code')?.toUpperCase() ?? null

  if (cf) {
    // Deduplica CROSS-SEDE deliberata: un adulto è una persona sola anche se ha
    // figli in due plessi. È la stessa scelta della strada manuale.
    const { data, error } = await supabase.from('parents').select('id').eq('fiscal_code', cf).maybeSingle()
    if (error) return { errore: `lettura genitore non riuscita: ${error.message}` }
    if (data) return { id: (data as { id: string }).id, creato: false }
  }

  const record = buildParentRecord({
    first_name: campo(grezzo, 'first_name'),
    last_name: campo(grezzo, 'last_name'),
    fiscal_code: cf,
    birth_date: campo(grezzo, 'birth_date'),
    birth_place: campo(grezzo, 'birth_place'),
    birth_province: campo(grezzo, 'birth_province'),
    birth_nation: campo(grezzo, 'birth_nation'),
    citizenship: campo(grezzo, 'citizenship'),
    address: campo(grezzo, 'address'),
    civico: campo(grezzo, 'residence_street_number'),
    residence_city: campo(grezzo, 'residence_city'),
    residence_province: campo(grezzo, 'residence_province'),
    zip_code: campo(grezzo, 'zip_code'),
    role: campo(grezzo, 'ruolo') ?? 'delegate',
    emails: campo(grezzo, 'email') ? [campo(grezzo, 'email')!.toLowerCase()] : [],
    phones: campo(grezzo, 'phone') ? [campo(grezzo, 'phone')!] : [],
  })

  const { data, error } = await supabase.from('parents').insert(record).select('id').single()
  if (error || !data) return { errore: `genitore non inserito: ${error?.message ?? 'nessuna riga'}` }

  const id = (data as { id: string }).id
  await supabase.rpc('iscrizioni_segna_creato', {
    p_submission_id: submissionId,
    p_tipo: 'parent',
    p_id: id,
  })
  return { id, creato: true }
}

/** Trova un `alunno` per codice fiscale nella sede, oppure lo crea. */
async function alunnoDiRiferimento(
  supabase: SupabaseClient,
  grezzo: unknown,
  assegnazione: AssegnazioneBambino,
  scuolaId: string,
  submissionId: string,
): Promise<{ id: string } | { errore: string }> {
  const cf = campo(grezzo, 'codice_fiscale')?.toUpperCase() ?? null

  if (cf) {
    const { data, error } = await supabase
      .from('alunni')
      .select('id, scuola_id')
      .eq('codice_fiscale', cf)
      .maybeSingle()
    if (error) return { errore: `lettura alunno non riuscita: ${error.message}` }
    if (data) {
      const trovato = data as { id: string; scuola_id: string }
      // Lo stesso codice fiscale in un'ALTRA sede non si tocca: sarebbe un
      // trasferimento, e un trasferimento lo decide una persona.
      if (trovato.scuola_id !== scuolaId) {
        return { errore: `il codice fiscale risulta già iscritto in un'altra sede: va risolto a mano` }
      }
      // Esiste già qui: si aggiorna solo classe e retta, senza ricrearlo.
      const { error: errUp } = await supabase
        .from('alunni')
        .update({
          classe_sezione: assegnazione.classe,
          importo_retta_mensile: assegnazione.retta,
        })
        .eq('id', trovato.id)
      if (errUp) return { errore: `alunno non aggiornato: ${errUp.message}` }
      return { id: trovato.id }
    }
  }

  const record: Record<string, unknown> = {
    scuola_id: scuolaId,
    nome: assegnazione.nome,
    cognome: assegnazione.cognome,
    data_nascita: campo(grezzo, 'data_nascita'),
    codice_fiscale: cf,
    gender: campo(grezzo, 'gender'),
    citizenship: campo(grezzo, 'citizenship'),
    birth_nation: campo(grezzo, 'birth_nation'),
    birth_province: campo(grezzo, 'birth_province'),
    birth_city: campo(grezzo, 'birth_city'),
    residence_address: campo(grezzo, 'residence_address'),
    residence_street_number: campo(grezzo, 'residence_street_number'),
    residence_city: campo(grezzo, 'residence_city'),
    residence_province: campo(grezzo, 'residence_province'),
    zip_code: campo(grezzo, 'zip_code'),
    allergies: campo(grezzo, 'allergies'),
    note_mediche: campo(grezzo, 'note_mediche'),
    stato: STATO_ISCRITTO,
    // La classe si scrive come TESTO: è il trigger `sync_alunno_section_id` a
    // risolvere `section_id`, confrontando senza maiuscole né spazi.
    classe_sezione: assegnazione.classe,
    importo_retta_mensile: assegnazione.retta,
  }

  const { data, error } = await supabase.from('alunni').insert(record).select('id').single()
  if (error || !data) return { errore: `alunno non inserito: ${error?.message ?? 'nessuna riga'}` }

  const id = (data as { id: string }).id
  await supabase.rpc('iscrizioni_segna_creato', {
    p_submission_id: submissionId,
    p_tipo: 'alunno',
    p_id: id,
  })
  return { id }
}

/**
 * Esegue una domanda già decisa. Non decide più niente: la decisione è arrivata
 * da `decidi()`, e qui si scrive soltanto.
 */
export async function eseguiDomanda(
  supabase: SupabaseClient,
  domanda: Domanda,
  dati: DatiGrezzi,
  assegnazioni: AssegnazioneBambino[],
  scuolaId: string,
): Promise<EsitoEsecuzione> {
  const bambiniGrezzi = Array.isArray(dati.children) ? dati.children : []
  const adultiGrezzi = Array.isArray(dati.adults) ? dati.adults : []

  const fallisci = async (errore: string): Promise<EsitoEsecuzione> => {
    const { data } = await supabase.rpc('iscrizioni_annulla', {
      p_submission_id: domanda.id,
      p_errore: errore,
    })
    logEvento(
      'iscrizione',
      'error',
      {
        operazione: OPERAZIONE,
        esito: 'domanda-annullata',
        entita_id: domanda.id,
        sede_id: scuolaId,
        stato: String(data ?? ''),
      },
      new Error(errore),
    )
    return { esito: 'errore', messageId: null, errore, emailSpedite: 0 }
  }

  /**
   * Come `fallisci`, ma per il «non oggi»: disfa senza consumare un tentativo.
   *
   * Con `iscrizioni_annulla` una quota esaurita costerebbe un tentativo, e tre
   * giorni di quota stretta porterebbero a `bloccata` domande perfettamente
   * buone — che è precisamente il danno che il 429-come-rinvio esiste per
   * evitare. `iscrizioni_rinvia` disfa le stesse cose e lascia il contatore dov'è.
   */
  const rinvia = async (motivo: string): Promise<EsitoEsecuzione> => {
    await supabase.rpc('iscrizioni_rinvia', {
      p_submission_id: domanda.id,
      p_motivo: motivo,
    })
    logEvento('iscrizione', 'warn', {
      operazione: OPERAZIONE,
      esito: 'domanda-rinviata',
      entita_id: domanda.id,
      sede_id: scuolaId,
      msg: `${OPERAZIONE}: domanda rinviata a domani (quota email)`,
    })
    return { esito: 'rinviata', messageId: null, errore: motivo, emailSpedite: 0 }
  }

  // ── 1. ANAGRAFICA ─────────────────────────────────────────────────────────
  const parentIds: string[] = []
  /** Gli adulti con un'email, in ordine: il primo è il referente. */
  const conEmail: { parentId: string; grezzo: unknown; email: string }[] = []

  for (const a of adultiGrezzi) {
    const esito = await parentDiRiferimento(supabase, a, domanda.id)
    if ('errore' in esito) return fallisci(esito.errore)
    parentIds.push(esito.id)
    const email = campo(a, 'email')
    if (email) conEmail.push({ parentId: esito.id, grezzo: a, email: normalizzaEmail(email) })
  }
  if (conEmail.length === 0) {
    return fallisci('nessun adulto con email: non c\'è dove mandare le credenziali')
  }
  const referente = conEmail[0]
  const referenteParentId = referente.parentId

  const alunnoPerNome = new Map<string, string>()
  for (const ass of assegnazioni) {
    const grezzo = bambiniGrezzi[ass.indice]
    const esito = await alunnoDiRiferimento(supabase, grezzo, ass, scuolaId, domanda.id)
    if ('errore' in esito) return fallisci(esito.errore)
    alunnoPerNome.set(normalizzaNome(`${ass.cognome} ${ass.nome}`), esito.id)

    for (const pid of parentIds) {
      const { error } = await supabase.from('student_parents').upsert(
        { student_id: esito.id, parent_id: pid, is_primary: pid === referenteParentId },
        { onConflict: 'student_id,parent_id' },
      )
      if (error) return fallisci(`legame anagrafico non scritto: ${error.message}`)
    }
  }

  // La retta a carico di un fratello si scrive DOPO, quando tutti gli alunni
  // della domanda esistono: il fratello che paga può essere uno di loro.
  for (const ass of assegnazioni) {
    if (!ass.aCaricoDi) continue
    const mio = alunnoPerNome.get(normalizzaNome(`${ass.cognome} ${ass.nome}`))
    if (!mio) continue
    const fratelloId = await trovaFratelloPagante(supabase, ass.aCaricoDi, scuolaId, alunnoPerNome)
    // Se il fratello non è ancora in anagrafica la colonna resta NULL, e con
    // `importo_retta_mensile = 0` l'alunno prenderebbe la retta di default:
    // meglio fermarsi che generargli 150 € al mese.
    if (!fratelloId) {
      return fallisci(
        `la retta di ${ass.cognome} ${ass.nome} è a carico di ${ass.aCaricoDi}, che però non risulta ancora in anagrafica: senza il collegamento gli verrebbe generata la retta di default`,
      )
    }
    const { error } = await supabase
      .from('alunni')
      .update({ retta_a_carico_di: fratelloId })
      .eq('id', mio)
    if (error) return fallisci(`collegamento della retta non scritto: ${error.message}`)
  }

  const alunniDellaDomanda = [...alunnoPerNome.values()]

  // ── 2-3. L'ACCESSO E L'INVITO DEL REFERENTE — BLOCCANTI ───────────────────
  const invito = await invitaGenitore(
    supabase,
    {
      parentId: referenteParentId,
      nome: campo(referente.grezzo, 'first_name'),
      scuolaId,
      submissionId: domanda.id,
    },
    // `ritira`: se non parte si disfa tutto, quindi la riga di registro non deve
    // restare — domani la domanda ricomincia da zero, e una riga orfana
    // manderebbe le credenziali a un genitore senza più nessun figlio collegato.
    'ritira',
  )

  // ②③ La casella è già di un'ALTRA anagrafica genitore. Non è un errore: sono i
  // fratelli iscritti separatamente e le coppie che condividono la casella. Si
  // aggancia il bambino al genitore che possiede già l'account, e non si manda
  // niente — quell'account le credenziali le ha già ricevute a suo tempo.
  if (invito.tipo === 'condivisa') {
    const agganciato = await agganciaAlGemello(supabase, referente.email, alunniDellaDomanda, true)
    if (agganciato) {
      logEvento('anagrafica', 'warn', {
        operazione: OPERAZIONE,
        esito: 'genitore-condiviso-riusato',
        entita_id: agganciato,
        sede_id: scuolaId,
      })
      await chiudi(supabase, domanda.id, assegnazioni)
      await invitaGliAltri(supabase, conEmail.slice(1), scuolaId, domanda.id, alunniDellaDomanda)
      return { esito: 'gia_invitata', messageId: null, errore: null, emailSpedite: 0 }
    }
    // Nessun gemello da agganciare: la casella risulta conflittuale ma non
    // esiste l'anagrafica che la possiede. È un'incoerenza vera, non un caso
    // previsto, e va guardata da una persona invece che indovinata qui.
    return fallisci(`accesso del genitore non creato: ${invito.motivo}`)
  }

  if (invito.tipo === 'rinviata') return rinvia(invito.motivo)
  if (invito.tipo === 'fallita') return fallisci(`invito non spedito: ${invito.motivo}`)

  // ── 4. CHIUSURA ───────────────────────────────────────────────────────────
  await chiudi(supabase, domanda.id, assegnazioni)

  if (invito.tipo === 'gia_invitata') {
    // Il posto nel registro era già preso: l'alunno entra lo stesso, l'email non
    // riparte — ma gli ALTRI genitori possono non aver mai ricevuto la loro.
    const altre = await invitaGliAltri(supabase, conEmail.slice(1), scuolaId, domanda.id, alunniDellaDomanda)
    return { esito: 'gia_invitata', messageId: null, errore: null, emailSpedite: altre }
  }

  // Chi paga resta il referente: `sincronizzaLegamiRuntime` crea ogni legame con
  // `intestatario_fattura:false`, ed è giusto per i genitori che si aggiungono —
  // vedere il proprio figlio è un'altra cosa dall'essere intestatario della
  // fattura. Ma qualcuno deve esserlo, o la quota resta 0 per tutti e la
  // fatturazione non sa a chi intestare.
  await intestaAlReferente(supabase, invito.authUserId, alunniDellaDomanda)

  // ── 5. GLI ALTRI GENITORI, A DOMANDA GIÀ CHIUSA ───────────────────────────
  const altre = await invitaGliAltri(supabase, conEmail.slice(1), scuolaId, domanda.id, alunniDellaDomanda)

  logEvento('iscrizione', 'info', {
    operazione: OPERAZIONE,
    esito: 'domanda-conclusa',
    entita_id: domanda.id,
    sede_id: scuolaId,
    n: assegnazioni.length,
  })

  return { esito: 'inviata', messageId: invito.messageId, errore: null, emailSpedite: 1 + altre }
}

/** La domanda diventa `approved`, con le classi assegnate scritte accanto. */
async function chiudi(
  supabase: SupabaseClient,
  submissionId: string,
  assegnazioni: AssegnazioneBambino[],
): Promise<void> {
  const assegnate: Record<string, string> = {}
  for (const a of assegnazioni) assegnate[String(a.indice)] = a.classe
  await supabase.rpc('iscrizioni_chiudi', {
    p_submission_id: submissionId,
    p_assegnazioni: assegnate,
  })
}

/**
 * GLI ALTRI GENITORI — best-effort, e mai capaci di disfare niente.
 *
 * A questo punto la domanda è chiusa e il referente ha le sue credenziali in
 * casella. Un fallimento qui è una persona che dovrà aspettare la ripresa di
 * domani, non un'iscrizione da rifare: annullarla toglierebbe a una famiglia un
 * accesso che già funziona per rimediare a un accesso che ancora non funziona.
 *
 * @returns quante email sono uscite davvero.
 */
async function invitaGliAltri(
  supabase: SupabaseClient,
  altri: { parentId: string; grezzo: unknown; email: string }[],
  scuolaId: string,
  submissionId: string,
  alunni: string[],
): Promise<number> {
  let spedite = 0
  for (const a of altri) {
    const esito = await invitaGenitore(
      supabase,
      { parentId: a.parentId, nome: campo(a.grezzo, 'first_name'), scuolaId, submissionId },
      'registra',
    )
    if (esito.tipo === 'inviata') {
      spedite++
      // Lo stesso passo del digest: ~2 al secondo, che è il limite del provider.
      await new Promise((r) => setTimeout(r, 550))
    } else if (esito.tipo === 'condivisa') {
      // I due genitori hanno la stessa casella (11 domande su 390) oppure quella
      // casella è già di un'altra anagrafica. In entrambi i casi l'account
      // esiste: gli si aggancia il bambino, così chi entra lo vede davvero.
      await agganciaAlGemello(supabase, a.email, alunni, false)
    } else if (esito.tipo === 'rinviata') {
      // Quota esaurita: il resto degli altri genitori aspetta domani. La riga
      // resta `da_inviare` e la ripresa la ritrova.
      break
    }
  }
  return spedite
}

/**
 * Aggancia i bambini all'anagrafica che possiede GIÀ l'account di quella casella.
 *
 * `ignoreDuplicates` non è stile: senza, un legame già scritto verrebbe
 * riscritto con `is_primary` di questo giro, e il referente di una domanda
 * potrebbe perdere il suo primato per via di un secondo genitore omonimo di
 * casella. Una riparazione non disfa mai un dato già presente.
 *
 * @returns l'id del `parents` agganciato, oppure `null` se non ne esiste uno.
 */
async function agganciaAlGemello(
  supabase: SupabaseClient,
  email: string,
  alunni: string[],
  isPrimary: boolean,
): Promise<string | null> {
  const authId = await findAuthUserIdByEmail(supabase, email)
  if (!authId) return null

  const { data: gemello, error } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', authId)
    .maybeSingle()
  if (error) {
    logEvento('anagrafica', 'error', {
      operazione: OPERAZIONE,
      esito: 'gemello-non-letto',
      error_code: (error as { code?: string }).code ?? null,
    }, error)
    return null
  }
  const gemelloId = (gemello as { id: string } | null)?.id ?? null
  if (!gemelloId) return null

  for (const alunnoId of alunni) {
    const { error: errLegame } = await supabase.from('student_parents').upsert(
      { student_id: alunnoId, parent_id: gemelloId, is_primary: isPrimary },
      { onConflict: 'student_id,parent_id', ignoreDuplicates: true },
    )
    if (errLegame) {
      logEvento('anagrafica', 'error', {
        operazione: OPERAZIONE,
        esito: 'legame-gemello-non-scritto',
        entita_id: gemelloId,
      }, errLegame)
    }
  }
  await sincronizzaLegamiRuntime(supabase, gemelloId)
  return gemelloId
}

/**
 * Il referente è l'intestatario della fattura, al 100%.
 *
 * Non si sovrascrive MAI un intestatario già presente: se per quel bambino
 * qualcuno lo è già — la segreteria a mano, o una domanda precedente — quella
 * decisione vale più di questa. Serve a non lasciare la quota a 0 per tutti, che
 * è ciò che accadrebbe altrimenti: `sincronizzaLegamiRuntime` crea ogni legame
 * con `intestatario_fattura:false`, e la fatturazione non saprebbe a chi
 * intestare. È la stessa regola della strada manuale
 * (`src/app/api/admin/iscrizioni/route.ts`), scritta qui perché le due strade
 * devono lasciare la stessa famiglia nello stesso stato.
 */
async function intestaAlReferente(
  supabase: SupabaseClient,
  accountId: string,
  alunni: string[],
): Promise<void> {
  if (alunni.length === 0) return

  const { data, error } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .in('alunno_id', alunni)
    .eq('intestatario_fattura', true)
  if (error) {
    // PostgREST non lancia. Senza il controllo del ritorno non si saprebbe se
    // «nessun intestatario» significa davvero nessuno o solo lettura fallita, e
    // nel dubbio non si scrive: una fattura intestata alla persona sbagliata è
    // peggio di una quota a zero, che almeno si vede.
    logEvento('anagrafica', 'error', {
      operazione: OPERAZIONE,
      esito: 'intestatario-non-letto',
      n: alunni.length,
      error_code: (error as { code?: string }).code ?? null,
    }, error)
    return
  }

  const gia = new Set((data ?? []).map((r) => String((r as { alunno_id: string }).alunno_id)))
  const senza = alunni.filter((a) => !gia.has(a))
  if (senza.length === 0) return

  const { error: errUp } = await supabase
    .from('legame_genitori_alunni')
    .update({ intestatario_fattura: true, percentuale_pagamento: 100 })
    .eq('genitore_id', accountId)
    .in('alunno_id', senza)
  if (errUp) {
    logEvento('anagrafica', 'error', {
      operazione: OPERAZIONE,
      esito: 'intestatario-non-scritto',
      entita_id: accountId,
      n: senza.length,
    }, errUp)
    return
  }

  logEvento('anagrafica', 'info', {
    operazione: OPERAZIONE,
    esito: 'intestatario-assegnato',
    entita_id: accountId,
    n: senza.length,
  })
}

/** L'alunno che paga per il fratello: prima fra quelli appena creati, poi in anagrafica. */
async function trovaFratelloPagante(
  supabase: SupabaseClient,
  nomeFratello: string,
  scuolaId: string,
  appenaCreati: Map<string, string>,
): Promise<string | null> {
  const chiave = normalizzaNome(nomeFratello)
  const fraQuestiIds = appenaCreati.get(chiave)
  if (fraQuestiIds) return fraQuestiIds

  // Solo chi è ISCRITTO: la retta di un bambino non può essere a carico di un
  // fratello ritirato, e un elenco di sede senza filtro di stato è precisamente
  // ciò che il lock `elenchi-operativi-solo-iscritti` esiste per impedire.
  const { data } = await supabase
    .from('alunni')
    .select('id, nome, cognome')
    .eq('scuola_id', scuolaId)
    .eq('stato', STATO_ISCRITTO)
    .is('archiviato_il', null)
  for (const r of data ?? []) {
    const o = r as { id: string; nome: string; cognome: string }
    if (normalizzaNome(`${o.cognome} ${o.nome}`) === chiave) return o.id
  }
  return null
}
