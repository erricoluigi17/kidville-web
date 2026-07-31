import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from './require-staff'
import { sezioniDiUtente } from '@/lib/sezioni/docenti'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// Scoping per tenant (plesso) e per classe delle funzioni docente.
//
// Modello (decisione di prodotto, PRD §3/§12):
//  - educator   → SOLO le sezioni assegnate (utenti_sezioni), nel proprio plesso.
//  - segreteria → TUTTE le classi del PROPRIO plesso (utenti.scuola_id).
//  - coordinator→ come oggi: tutte le classi del proprio plesso.
//  - admin      → Direzione: tutti i plessi in utenti_scuole (fallback scuola_id).
// Mai cross-tenant. Da usare SEMPRE dopo `requireDocente` (che verifica il ruolo
// ma non lo scope). Le funzioni "assert*" tornano una NextResponse 4xx pronta
// oppure null se l'accesso è consentito.
// =============================================================================

/**
 * Codici che significano «questa TABELLA non esiste in questo database» —
 * `42P01` (Postgres) e `PGRST205` (PostgREST non la trova nella schema cache).
 * NON ci sono i codici di COLONNA (`42703`, `PGRST204`): su `utenti_scuole` si
 * legge `scuola_id`, che sta nel baseline. Lì un errore di colonna non è «CI non
 * migrata», è la colonna sparita — e allora si nega.
 */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

/**
 * Plessi (schools.id) su cui l'utente può operare.
 *
 * ⚠️ FAIL-CLOSED, e non è una precauzione teorica. PostgREST non lancia: fino al
 * 2026-07-31 `{ error }` qui non veniva guardato, quindi una lettura fallita del
 * ponte lasciava `data` a null, `extra` a `[]` e l'admin di tre sedi diventava
 * di UNA — la primaria. Da lì `resolveScuolaScrittura` imboccava il ramo
 * `accessibili.length === 1` e archiviava il dato a Giugliano **senza il 400 e
 * senza il warn**: cioè il difetto che l'audit aveva appena rimosso, rientrato
 * da una porta laterale. Restava solo la riga `db error` del fetch strumentato,
 * che dice «PostgREST ha risposto male su utenti_scuole» e non «una scrittura è
 * finita nel plesso sbagliato».
 *
 * Un errore di lettura non è un permesso: se non si sa quali sedi ha l'utente,
 * non ne ha nessuna. Tutti i chiamanti trattano lo scope vuoto come diniego
 * (403 sulle scritture, elenco vuoto sulle letture), quindi il contratto regge
 * senza cambiare la firma su 50 file.
 *
 * Unica deroga: la tabella ponte ASSENTE per intero. Dove `utenti_scuole` non
 * esiste nessuno è multi-plesso, quindi la sede primaria è la verità completa e
 * non un restringimento silenzioso — ma resta un `warn` persistito, perché in
 * produzione quella tabella c'è e la sua sparizione è un incidente.
 */
export async function scuoleDiUtente(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[]> {
  const own = user.scuola_id ? [user.scuola_id] : []
  // Solo la Direzione (admin) può essere multi-plesso via utenti_scuole.
  if (user.role !== 'admin') return own
  const { data, error } = await supabase
    .from('utenti_scuole')
    .select('scuola_id')
    .eq('utente_id', user.id)
  if (error) {
    const codice = (error as { code?: string }).code ?? ''
    if (TABELLA_ASSENTE.has(codice)) {
      logEvento('auth', 'warn', {
        tipo: 'sedi-utente-ponte-assente', azione: 'scuoleDiUtente',
        utente: user.id, ruolo: user.role,
      }, error)
      return own
    }
    logEvento('auth', 'error', {
      tipo: 'sedi-utente-non-risolte', azione: 'scuoleDiUtente',
      utente: user.id, ruolo: user.role,
    }, error)
    return []
  }
  const extra = (data ?? []).map((r) => r.scuola_id as string)
  const set = new Set<string>([...own, ...extra])
  return [...set]
}

// =============================================================================
// Sedi attive (selezione del SedeSelector → cookie). La selezione è una
// preferenza UI: viene SEMPRE ri-validata server-side contro le sedi accessibili
// (scuoleDiUtente), quindi manometterla non dà accesso a plessi non propri.
// =============================================================================

const COOKIE_SEDI = 'sedi_attive'

function sediDalCookie(request: NextRequest): string[] {
  // Difensivo: in test l'oggetto request può non avere `.cookies`.
  const raw = request.cookies?.get?.(COOKIE_SEDI)?.value
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * LETTURE: insieme di plessi su cui filtrare (`scuola_id IN (...)`). Sono le sedi
 * selezionate nel SedeSelector (cookie) INTERSECATE con quelle accessibili.
 *
 * Cookie ASSENTE → tutte le accessibili (nessuna selezione = nessuna
 * restrizione). Cookie PRESENTE ma con intersezione vuota → `[]`, cioè si NEGA:
 * l'utente ha chiesto sedi che non sono (o non sono più) sue, e l'unica risposta
 * onesta è «niente», non «allora eccoti tutto». Fino al 2026-07-31 questo era
 * l'unico punto del modulo in cui il vuoto ALLARGAVA invece di restringere, e
 * mascherava l'unico segnale che dice «questo utente ha perso l'accesso a una
 * sede» oppure «qualcuno ha manomesso il cookie»: per questo ora lo si logga.
 */
export async function resolveScuoleAttive(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[]> {
  const accessibili = await scuoleDiUtente(supabase, user)
  const selezionate = sediDalCookie(request)
  if (selezionate.length === 0) return accessibili
  const set = new Set(accessibili)
  const inter = selezionate.filter((id) => set.has(id))
  if (inter.length === 0) {
    // `warn` → persistito: nessuna sede selezionata è accessibile. Solo uuid
    // utente, ruolo e conteggi: nessun dato di minori, nessuna sede in chiaro.
    logEvento('auth', 'warn', {
      tipo: 'sedi-attive-non-accessibili', azione: 'resolveScuoleAttive',
      utente: user.id, ruolo: user.role,
      selezionate: selezionate.length, accessibili: accessibili.length,
    })
  }
  return inter
}

/**
 * SCRITTURE (create/update che settano `scuola_id`): UNA sola sede, e la sede si
 * DICHIARA. Ordine: `preferita`/body.scuola_id se accessibile → l'unica sede
 * attiva (cookie) → l'unica sede accessibile. Se resta ambiguo — più sedi
 * accessibili e nessuna indicata — ritorna una NextResponse **400**.
 *
 * ⚠️ NIENTE RIPIEGO SULLA SEDE PRIMARIA. Fino al 2026-07-31 qui c'era un ultimo
 * ramo `if (user.scuola_id && set.has(user.scuola_id))`, e siccome
 * `scuoleDiUtente` mette la sede primaria per PRIMA (riga 25) e `utenti.scuola_id`
 * è NOT NULL, quel ramo scattava SEMPRE: il 400 era codice morto. Effetto reale:
 * l'admin che nel SedeSelector aveva scelto Aversa+Cesa — cioè aveva tolto
 * Giugliano — si vedeva archiviare il dato **a Giugliano**, senza errore e senza
 * log. Con tre plessi la «sede primaria» non è un default sensato: è solo la
 * prima che è stata assegnata all'utente. Chi ha un solo plesso non cambia
 * comportamento (ramo `accessibili.length === 1`); chi ne ha più d'uno deve dire
 * dove sta scrivendo.
 */
export async function resolveScuolaScrittura(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  preferita?: string | null,
): Promise<{ scuolaId?: string; response?: NextResponse }> {
  const accessibili = await scuoleDiUtente(supabase, user)
  if (accessibili.length === 0) {
    return { response: NextResponse.json({ error: 'Nessun plesso associato all\'utente' }, { status: 403 }) }
  }
  const set = new Set(accessibili)
  if (preferita && set.has(preferita)) return { scuolaId: preferita }
  const attive = sediDalCookie(request).filter((id) => set.has(id))
  if (attive.length === 1) return { scuolaId: attive[0] }
  if (accessibili.length === 1) return { scuolaId: accessibili[0] }
  // `warn` → persistito: una scrittura ambigua è un'operazione RIFIUTATA, e il
  // motivo deve essere leggibile senza risalire al corpo della richiesta.
  logEvento('auth', 'warn', {
    tipo: 'sede-scrittura-ambigua', azione: 'resolveScuolaScrittura',
    utente: user.id, ruolo: user.role,
    accessibili: accessibili.length, attive: attive.length,
    dichiarata: Boolean(preferita),
  })
  return { response: NextResponse.json({ error: 'Specificare la sede (scuola_id) per questa operazione' }, { status: 400 }) }
}

/**
 * Diniego per GUASTO, non per scope: 500 + una riga `error` che dice quale
 * verifica non è stata fatta.
 *
 * Esiste perché le sette `assert*` sbagliavano allo stesso modo in cinque punti
 * su sette: PostgREST non lancia, quindi una lettura fallita lasciava `data` a
 * null e la funzione rispondeva **404 «non trovato»** o **403 «fuori dal tuo
 * plesso»** — cioè affermava qualcosa sul dato che non aveva letto. Due danni,
 * non uno: chi riceve il 403 non sa che è un guasto, e i contatori
 * `*-fuori-sede` — che l'audit ha creato come segnale di sicurezza — si
 * riempiono di falsi positivi.
 *
 * Il messaggio è deliberatamente lo stesso per tutte: al client non serve sapere
 * QUALE tabella non si è letta (e non deve saperlo). Il `tipo` lo dice al log.
 */
function scopeNonRisolto(
  tipo: string,
  err: unknown,
  campi: Record<string, string | number | null | undefined> = {},
): NextResponse {
  logEvento('auth', 'error', { tipo, ...campi }, err)
  return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
}

/** True se l'utente ha visibilità su TUTTE le classi del proprio/i plesso/i. */
export function vedeTutteLeClassi(user: AppUser): boolean {
  return user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
}

/**
 * Filtro per SEZIONE da applicare agli ELENCHI, complemento del filtro per sede.
 *
 * Ritorna `null` per chi vede tutte le classi del proprio plesso (admin,
 * coordinator, segreteria): nessuna restrizione oltre alla sede. Per l'`educator`
 * ritorna le sole sezioni assegnate in `utenti_sezioni` — decisione di prodotto
 * del 2026-07-30, presa dal titolare: 9 educator su 10 le hanno già assegnate.
 *
 * Fail-closed: un educator senza sezioni assegnate riceve `[]`, cioè un elenco
 * vuoto. È la risposta giusta — «non ti è stata assegnata nessuna classe» — e non
 * «eccoti tutte quelle del plesso».
 *
 * Uso tipico, in AND col filtro di sede:
 * ```ts
 * const plessi = await resolveScuoleAttive(request, supabase, user)
 * let q = supabase.from('...').select('..., alunni!inner(...)').in('alunni.scuola_id', plessi)
 * const mie = await sezioniVisibili(supabase, user)
 * if (mie) q = q.in('alunni.section_id', mie)
 * ```
 */
export async function sezioniVisibili(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<string[] | null> {
  if (vedeTutteLeClassi(user)) return null
  return await sezioniDiUtente(supabase, user.id)
}

/**
 * Verifica che `sectionId` sia nello scope dell'utente. Per `educator` richiede
 * anche che la sezione sia assegnata (utenti_sezioni). 403/404 se fuori scope.
 */
export async function assertSezioneInScope(
  supabase: SupabaseClient,
  user: AppUser,
  sectionId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!sectionId) {
    return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
  }
  const { data: section, error } = await supabase
    .from('sections')
    .select('id, scuola_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-sezione-non-risolta', error, { utente: user.id })
  if (!section) {
    return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!section.scuola_id || !plessi.includes(section.scuola_id as string)) {
    return NextResponse.json({ error: 'Accesso negato: classe fuori dal tuo plesso' }, { status: 403 })
  }

  if (!vedeTutteLeClassi(user)) {
    const mie = await sezioniDiUtente(supabase, user.id)
    if (!mie.includes(sectionId)) {
      return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
    }
  }
  return null
}

/**
 * Verifica che una classe identificata per NOME (es. 'Girasoli') appartenga a un
 * plesso dell'utente. Per i moduli 0-6/trasversali keyed sul nome sezione: il
 * nome viene risolto SOLO entro i plessi consentiti, così non porta mai
 * cross-tenant (i nomi sono unici solo per scuola_id). 403 se fuori scope.
 *
 * ⚠️ Da quando le sedi sono TRE il nome-classe NON è più una chiave univoca:
 * «2 ANNI» e «5 ANNI» esistono sia ad Aversa sia a Cesa. Questo assert impedisce
 * di *nominare* una classe altrui, ma non filtra le righe: chi legge alunni per
 * `classe_sezione` deve comunque restringere la query per sede
 * (`.in('scuola_id', …)`), altrimenti l'omonimia porta dentro i bambini
 * dell'altra sede. Gate e filtro, sempre entrambi.
 *
 * @param opts.soloSezioniAssegnate  per `educator` (e chiunque non veda tutte le
 *   classi del plesso, cfr. `vedeTutteLeClassi`) esige che la classe sia fra
 *   quelle assegnate in `utenti_sezioni`. Non tocca admin/coordinator/segreteria,
 *   che per progetto vedono TUTTE le classi del proprio plesso.
 */
export async function assertClasseNomeInScope(
  supabase: SupabaseClient,
  user: AppUser,
  classeNome: string | null | undefined,
  opts?: { soloSezioniAssegnate?: boolean },
): Promise<NextResponse | null> {
  if (!classeNome) {
    return NextResponse.json({ error: 'classe (nome) obbligatoria' }, { status: 400 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length === 0) {
    return NextResponse.json({ error: 'Nessun plesso associato' }, { status: 403 })
  }
  // Niente `.limit(1)`: con `soloSezioniAssegnate` servono TUTTE le sezioni
  // omonime dentro i propri plessi per intersecarle con quelle del docente.
  // L'insieme è comunque minuscolo (una riga per sede accessibile).
  const { data, error } = await supabase
    .from('sections')
    .select('id')
    .eq('name', classeNome)
    .in('scuola_id', plessi)
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un 403 muto, indistinguibile da un tentativo cross-sede.
    return scopeNonRisolto('scope-classe-non-risolta', error, { sezione: classeNome })
  }
  if (data.length === 0) {
    // `warn` → persistito: «qualcuno ha chiesto una classe che non è nei suoi
    // plessi» è un segnale di sicurezza, non rumore. Solo uuid utente, ruolo e
    // nome-classe (in lista bianca): nessun dato di minori.
    logEvento('auth', 'warn', {
      tipo: 'classe-fuori-sede', azione: 'assertClasseNomeInScope',
      utente: user.id, ruolo: user.role, sezione: classeNome,
    })
    return NextResponse.json({ error: 'Classe fuori dal tuo plesso' }, { status: 403 })
  }

  if (opts?.soloSezioniAssegnate && !vedeTutteLeClassi(user)) {
    const mie = new Set(await sezioniDiUtente(supabase, user.id))
    if (!data.some((s) => mie.has(s.id as string))) {
      logEvento('auth', 'warn', {
        tipo: 'classe-non-assegnata', azione: 'assertClasseNomeInScope',
        utente: user.id, ruolo: user.role, sezione: classeNome,
      })
      return NextResponse.json({ error: 'Classe non assegnata al docente' }, { status: 403 })
    }
  }
  return null
}

/**
 * Verifica batched che TUTTI gli alunni indicati appartengano alla sezione data.
 * Per gli handler che ricevono array di alunno_id dentro una sezione GIÀ asserita
 * con assertSezioneInScope (appello, note, destinatari registro, giudizi scrutinio):
 * impedisce scritture/notifiche verso alunni di altre sezioni/plessi. 403 se anche
 * un solo id è estraneo alla sezione.
 */
export async function assertAlunniInSezione(
  supabase: SupabaseClient,
  alunnoIds: (string | null | undefined)[],
  sectionId: string,
): Promise<NextResponse | null> {
  const ids = [...new Set(alunnoIds.filter(Boolean) as string[])]
  if (ids.length === 0) return null
  const { data, error } = await supabase
    .from('alunni')
    .select('id')
    .in('id', ids)
    .eq('section_id', sectionId)
  // Senza questo controllo una lettura fallita («data: null») faceva risultare
  // estranei TUTTI gli id: un 403 che accusa anche gli alunni giusti, e che il
  // chiamante non può distinguere da un vero tentativo cross-sezione.
  if (error) return scopeNonRisolto('scope-alunni-non-risolti', error, { sezione: sectionId })
  const inSezione = new Set((data ?? []).map((r) => r.id as string))
  const estranei = ids.filter((id) => !inSezione.has(id))
  if (estranei.length > 0) {
    // Gli uuid NON tornano nel corpo. Fino al 2026-07-31 la risposta li
    // elencava: a chi ha appena provato a toccare alunni non suoi si
    // confermava, id per id, quali esistono e non sono nella sezione — l'unica
    // informazione che quel 403 esiste per non dare. Per la diagnosi restano la
    // sezione, i due conteggi e — sul canale persistito — il payload già redatto
    // dal contesto di richiesta, dove gli id (uuid) ci sono per intero.
    logEvento('auth', 'warn', {
      tipo: 'alunni-fuori-sezione', azione: 'assertAlunniInSezione',
      sezione: sectionId, n: estranei.length, richiesti: ids.length,
    })
    return NextResponse.json(
      { error: 'Alunni non appartenenti alla sezione' },
      { status: 403 }
    )
  }
  return null
}

/**
 * Verifica che un altro membro dello STAFF (`utenti.id`) sia nel plesso
 * dell'utente. Per le operazioni che agiscono su un collega — reset delle
 * credenziali, assegnazione a una sezione, cambio di ruolo — dove il solo gate
 * di ruolo lasciava agire sul personale di un'altra sede. 403/404 se fuori scope.
 */
export async function assertUtenteInScope(
  supabase: SupabaseClient,
  user: AppUser,
  utenteId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!utenteId) {
    return NextResponse.json({ error: 'utenteId obbligatorio' }, { status: 400 })
  }
  const { data: bersaglio, error } = await supabase
    .from('utenti')
    .select('id, scuola_id')
    .eq('id', utenteId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-utente-non-risolto', error, { utente: user.id })
  if (!bersaglio) {
    return NextResponse.json({ error: 'Utente non trovato' }, { status: 404 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (!bersaglio.scuola_id || !plessi.includes(bersaglio.scuola_id as string)) {
    logEvento('auth', 'warn', {
      tipo: 'utente-fuori-sede', azione: 'assertUtenteInScope',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Utente fuori dal tuo plesso' }, { status: 403 })
  }
  return null
}

/**
 * Verifica che un PAGAMENTO sia nel plesso dell'utente.
 *
 * `pagamenti` ha già `scuola_id`, e per la contabilità è quella che conta: una
 * retta appartiene a un plesso, indipendentemente da dove sia il bambino
 * adesso. Serve a tutte le route che agiscono su un pagamento per uuid —
 * incassi, storni, sconti, quote, fatture, ricevute — dove il solo gate di
 * ruolo lasciava incassare e stornare sulle rette di un'altra sede.
 *
 * Sede assente sulla riga ⇒ si nega: un movimento contabile senza plesso non è
 * attribuibile a nessuno.
 */
export async function assertPagamentoInScope(
  supabase: SupabaseClient,
  user: AppUser,
  pagamentoId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!pagamentoId) {
    return NextResponse.json({ error: 'pagamento_id obbligatorio' }, { status: 400 })
  }
  const { data: pagamento, error } = await supabase
    .from('pagamenti')
    .select('id, scuola_id')
    .eq('id', pagamentoId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-pagamento-non-risolto', error, { utente: user.id })
  if (!pagamento) {
    return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  const sede = (pagamento.scuola_id as string | null) ?? null
  if (!sede || !plessi.includes(sede)) {
    logEvento('auth', 'warn', {
      tipo: 'pagamento-fuori-sede', azione: 'assertPagamentoInScope',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Pagamento fuori dal tuo plesso' }, { status: 403 })
  }
  return null
}

/**
 * Verifica che un GENITORE sia nello scope dell'utente.
 *
 * `parents` non ha `scuola_id`, e **non deve averlo**: un genitore può avere
 * legittimamente figli in due sedi diverse, quindi non esiste «la sua sede». Lo
 * scope si deriva dai FIGLI: il genitore è raggiungibile se almeno uno dei suoi
 * figli sta in un plesso dell'utente. Da usare su tutte le route che leggono o
 * scrivono l'anagrafica dei genitori per id (CF, documento d'identità,
 * indirizzo, recapiti) — dove il solo `requireStaff` lasciava passare qualunque
 * genitore delle tre sedi.
 *
 * Fail-closed: nessun plesso, errore di lettura, o nessun figlio in scope → si
 * nega. Un genitore senza figli collegati non è raggiungibile da nessuno: è la
 * risposta giusta, perché non c'è modo di stabilire a quale plesso appartenga.
 */
export async function assertParentInScope(
  supabase: SupabaseClient,
  user: AppUser,
  parentId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!parentId) {
    return NextResponse.json({ error: 'parentId obbligatorio' }, { status: 400 })
  }
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length === 0) {
    return NextResponse.json({ error: 'Nessun plesso associato' }, { status: 403 })
  }
  const { data, error } = await supabase
    .from('student_parents')
    .select('student_id, alunni!inner(scuola_id)')
    .eq('parent_id', parentId)
    .in('alunni.scuola_id', plessi)
  if (error) {
    // PostgREST non lancia: senza questo controllo un guasto di lettura
    // diventerebbe un 403 muto, indistinguibile da un tentativo cross-sede.
    return scopeNonRisolto('scope-genitore-non-risolto', error, { utente: user.id })
  }
  if (data && data.length > 0) return null

  // ── Da qui in giù si NEGA comunque: si stabilisce solo COME, e cosa scrivere.
  //
  // Fino al 2026-07-31 tutto questo era un `return 403 + warn genitore-fuori-sede`.
  // Provato con un uuid inesistente, rispondeva «Genitore fuori dal tuo plesso»
  // e incrementava un contatore nato come SEGNALE DI SICUREZZA: bastavano i 404
  // banali di un id sbagliato per riempirlo, e il giorno in cui qualcuno prova
  // davvero a leggere il genitore di un'altra sede quel segnale non si distingue
  // dal rumore. «Non è tuo» e «non esiste» sono due cose diverse e vanno dette
  // diverse. Il costo sta tutto sul ramo di diniego: il percorso felice resta
  // una query sola.
  const { data: altrove, error: errAltrove } = await supabase
    .from('student_parents')
    .select('student_id, alunni!inner(scuola_id)')
    .eq('parent_id', parentId)
    .limit(1)
  if (errAltrove) return scopeNonRisolto('scope-genitore-non-risolto', errAltrove, { utente: user.id })
  if (altrove && altrove.length > 0) {
    // Ha figli, ma non nei tuoi plessi: QUESTO è il tentativo cross-sede.
    logEvento('auth', 'warn', {
      tipo: 'genitore-fuori-sede', azione: 'assertParentInScope',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Genitore fuori dal tuo plesso' }, { status: 403 })
  }

  // Nessun figlio collegato: o l'anagrafica non esiste (404 banale), o esiste e
  // non è attribuibile a nessun plesso (403, ma non è un tentativo).
  const { data: anagrafica, error: errAnagrafica } = await supabase
    .from('parents')
    .select('id')
    .eq('id', parentId)
    .maybeSingle()
  if (errAnagrafica) {
    // Mai affermare «non trovato» su un dato che non si è riusciti a leggere.
    return scopeNonRisolto('scope-genitore-non-risolto', errAnagrafica, { utente: user.id })
  }
  if (!anagrafica) {
    return NextResponse.json({ error: 'Genitore non trovato' }, { status: 404 })
  }
  logEvento('auth', 'warn', {
    tipo: 'genitore-senza-figli', azione: 'assertParentInScope',
    utente: user.id, ruolo: user.role,
  })
  return NextResponse.json({ error: 'Genitore non collegato a nessun alunno' }, { status: 403 })
}

/**
 * Verifica che l'alunno (`alunnoId`) sia nello scope dell'utente, risolvendo la
 * sua sezione/plesso. Per gli endpoint che ricevono alunnoId e non sectionId
 * (valutazioni, prospetto, fascicolo, diario, ...). 403/404 se fuori scope.
 */
export async function assertAlunnoInScope(
  supabase: SupabaseClient,
  user: AppUser,
  alunnoId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!alunnoId) {
    return NextResponse.json({ error: 'alunnoId obbligatorio' }, { status: 400 })
  }
  const { data: alunno, error } = await supabase
    .from('alunni')
    .select('id, section_id, scuola_id')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error) return scopeNonRisolto('scope-alunno-non-risolto', error, { utente: user.id })
  if (!alunno) {
    return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!alunno.scuola_id || !plessi.includes(alunno.scuola_id as string)) {
    return NextResponse.json({ error: 'Accesso negato: alunno fuori dal tuo plesso' }, { status: 403 })
  }

  if (!vedeTutteLeClassi(user)) {
    const mie = await sezioniDiUtente(supabase, user.id)
    if (!alunno.section_id || !mie.includes(alunno.section_id as string)) {
      return NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 })
    }
  }
  return null
}
