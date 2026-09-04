import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppRole } from '@/lib/auth/require-staff'
import {
  assertSezioneInScope,
  assertUtenteInScope,
  formaConfronto,
  resolveScuoleAttive,
  scuoleDiUtente,
} from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { RUOLI_VALIDI } from '@/lib/auth/ruoli'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { destinazioneConsentita, destinazioniDiTrasferimento } from '@/lib/sedi/trasferimento'
import { puoModificareIncaricoStaff, type CambiIncarico } from '@/lib/auth/incarico-staff'
// ⚠️ Da `predicati-ruolo` e NON da `require-staff`, che pure lo ri-esporta: 296
// file di test sostituiscono `require-staff` PER INTERO con una factory, e un
// valore importato da lì arriverebbe `undefined` dentro la rotta sotto test. La
// testata di `predicati-ruolo.ts` racconta i 46 test che l'hanno misurato.
import { type AppUser, haRuolo } from '@/lib/auth/predicati-ruolo'

const DIREZIONE = ['admin', 'coordinator'] as const
// Lettura estesa alla Segreteria (T3): l'elenco del personale è consultabile anche
// dalla Segreteria.
const LETTURA = [...DIREZIONE, 'segreteria'] as const
// SCRITTURA: dal 2026-09-04 anche la Segreteria, ma il gate di rotta è solo il
// primo dei due. Quali CAMPI possa toccare lo decide `puoModificareIncaricoStaff`,
// dentro l'handler e dopo aver letto il ruolo del bersaglio: la Segreteria sposta
// di sede, e nient'altro.
const SCRITTURA = [...DIREZIONE, 'segreteria'] as const

const OPERAZIONE_PATCH = 'admin/staff:PATCH'

/**
 * IL RUOLO CON CUI SI È DECISO — e mai la veste indossata adesso.
 *
 * `auth.user.role` è PRESENTAZIONE: è la vista che la persona sta guardando, e
 * cambia col cookie `kv-active-role`. Fino al 2026-09-04 finiva sotto il nome
 * `ruolo` in tre righe di sicurezza di questa rotta, e per una segretaria che
 * stava guardando l'app come mamma usciva `ruolo: 'genitore'`. È un falso
 * allarme nel conteggio dei tentativi e — molto peggio — il travestimento
 * perfetto di un allarme vero: l'autorizzazione l'ha data un ruolo che nella
 * riga non compare. AUTORIZZAZIONE = ruoli reali; PRESENTAZIONE = veste.
 * Stessa scelta e stessa motivazione di `ruoloCheDecide` in
 * `src/lib/sedi/trasferimento.ts`, che le sue righe le scrive già così.
 *
 * ⚠️ SI DERIVA DA `SCRITTURA`, la costante del gate di QUESTA rotta, invece di
 * ricopiare la cascata di `trasferimento.ts`: quella risponde a «verso dove puoi
 * spostare», questa a «con quale potere sei entrato qui». Sono due domande
 * diverse che oggi danno la stessa risposta, e ricopiarne una sarebbe la solita
 * regola scritta due volte — quella che prima o poi diverge. Così, il giorno in
 * cui il gate di rotta cambiasse, il log lo seguirebbe da solo.
 *
 * `null` è possibile e non è un errore: `requireStaff` fa passare sui ruoli
 * reali, ma un test che costruisce un `AppUser` a mano può non averne nessuno
 * fra questi tre. `null` dice «nessuno dei ruoli ammessi», che è un fatto.
 */
function ruoloDecidente(user: AppUser): AppRole | null {
  return SCRITTURA.find((r) => haRuolo(user, r)) ?? null
}

/**
 * IL 500 DI UNA LETTURA O SCRITTURA RESPINTA, detto in un posto solo.
 *
 * PostgREST NON lancia: ritorna `{ error }`, e ogni punto che lo controlla deve
 * loggare e rispondere. Scritto a mano in dieci punti sarebbero dieci risposte
 * d'errore senza `codice` — debito che cresce dentro il file che
 * `errori-con-codice` sorveglia — e dieci occasioni di dimenticare il log.
 * ⚠️ `withRoute` non vede né le eccezioni catturate né gli `{ error }`: se non si
 * logga qui, di questo guasto non resta traccia da nessuna parte.
 *
 * `evento` dice QUALE lettura o scrittura è stata respinta: senza, dieci righe
 * `db` identiche non distinguono lo sgancio delle classi dalla potatura del
 * ponte, ed è la sola informazione che dice dove guardare.
 */
function erroreDb(operazione: string, evento: string, error: { message: string }): NextResponse {
  logErrore({ operazione, stato: 500, evento }, error)
  return NextResponse.json({ error: error.message }, { status: 500 })
}

/**
 * Codici che significano «questa TABELLA non esiste in questo database» —
 * `42P01` (Postgres) e `PGRST205` (PostgREST non la trova). Stessa coppia di
 * `scuoleDiUtente` (src/lib/auth/scope.ts) e per la stessa ragione: sul DB E2E
 * della CI, che non è migrato, `utenti_scuole` può non esserci, e lì «assente»
 * non è un guasto. Ogni ALTRO errore sì, e allora non si sposta nessuno.
 */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

/** L'insieme di uuid, nella forma su cui si confrontano (in Postgres `uuid` è un TIPO). */
const insiemeUuid = (v: readonly unknown[]): Set<string> =>
  new Set(v.map((x) => formaConfronto(String(x))))

/** Due insiemi di uuid sono lo stesso insieme? L'ORDINE non conta: è un insieme. */
function stessoInsieme(a: readonly unknown[], b: readonly unknown[]): boolean {
  const sa = insiemeUuid(a)
  const sb = insiemeUuid(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// PATCH — body: { id, ruolo?, scuola_id?, gradi?, section_ids? }.
// gradi/section_ids non-array oggi vengono ignorati in silenzio (Array.isArray
// nel codice): restano z.unknown() per non respingere richieste che oggi passano.
const patchBodySchema = z.object({
  id: zUuid, // obbligatorio (sostituisce il 400 manuale 'id è obbligatorio')
  // Stessi valori ammessi di isRuoloAssegnabile (sostituisce il 400 manuale).
  ruolo: z.enum(RUOLI_VALIDI as [AppRole, ...AppRole[]], { error: 'Ruolo non assegnabile' }).optional(),
  scuola_id: zUuid.nullish(), // null oggi arriva al DB così com'è: preservato
  gradi: z.unknown().optional(),
  section_ids: z.unknown().optional(),
})

// GET /api/admin/staff — elenco personale (esclude i genitori). Lettura estesa
// alla Segreteria, e dal 2026-09-04 anche la PATCH: ma solo per la SEDE, e a
// dirlo non è il gate di rotta — è `puoModificareIncaricoStaff`, dentro
// l'handler, dopo aver letto il ruolo del bersaglio.
//
// ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). Questo GET restituiva nome, cognome,
// email e sede di OGNI dipendente delle tre sedi, TUTTE le classi e TUTTE le
// assegnazioni. Non sono dati di minori, ma sono dati personali di lavoratori —
// e la mappa completa delle sezioni è l'inventario di uuid che serve per
// sfruttare gli altri difetti d'isolamento. Ora tutto è ristretto ai plessi
// attivi.
//
// ─── `schools` NON È LA TENDINA DEL TRASFERIMENTO, E NON DEVE DIVENTARLO ─────
//
// Fino al 2026-09-04 qui c'era scritto che le sedi «alimentano la tendina di
// riassegnazione, che la PATCH valida comunque contro `scuoleDiUtente`». Erano
// due affermazioni, e nello stesso lavoro sono decadute tutte e due:
//
//  · la PATCH non valida più la destinazione con `scuoleDiUtente`. Quel
//    controllo pretendeva che la sede d'arrivo fosse già fra quelle di chi
//    sposta, cioè negava esattamente il caso d'uso — la Direzione che manda una
//    maestra in un plesso che non è suo — ed è stato sostituito da
//    `destinazioniConsentita` (`src/lib/sedi/trasferimento.ts`);
//  · la tendina non si riempie più da qui. `schools` sono le sedi in cui
//    l'utente LAVORA: per una direttrice di Giugliano sono due su tre, e la
//    terza — l'unica che serve, perché un trasferimento è per definizione verso
//    un plesso in cui la persona NON è ancora — semplicemente non compariva.
//    Nessun errore e nessun log: una voce assente non fa rumore.
//
// E questa route non deve tornare a esporle, benché sarebbe comodo averle nella
// stessa risposta: le destinazioni hanno già una rotta loro,
// `GET /api/admin/sedi/destinazioni`, che chiama la regola vera e la logga una
// volta sola. Calcolarle una seconda volta qui vorrebbe dire tenere la stessa
// regola in due posti — se ne correggerebbe una e l'altra resterebbe indietro in
// silenzio, che in questo repo è già successo. Qui `schools` serve a un'altra
// cosa e resta com'è: dare un NOME alle sedi che l'elenco mostra.
export const GET = withRoute('admin/staff:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, [...LETTURA])
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ elenco vuoto: `.in()` incondizionato, mai `if (plessi.length)`.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    const accessibili = await scuoleDiUtente(supabase, auth.user)

    // contesto per la UI: personale + sedi + classi
    const [
      { data, error },
      { data: schools, error: errSchools },
      { data: sections, error: errSections },
    ] = await Promise.all([
      supabase
        .from('utenti')
        .select('id, nome, cognome, email, ruolo, scuola_id, gradi')
        .neq('ruolo', 'genitore')
        .in('scuola_id', plessi)
        .order('cognome', { ascending: true }),
      supabase.from('schools').select('id, nome').in('id', accessibili),
      supabase
        .from('sections')
        .select('id, name, scuola_id, school_type')
        .in('scuola_id', plessi)
        .order('name'),
    ])
    if (error) return erroreDb('admin/staff:GET', 'db-rubrica', error)
    // PostgREST non lancia: senza questi due controlli una lettura fallita
    // diventava una tendina vuota senza spiegazione (sedi/classi «sparite»).
    if (errSchools) logErrore({ operazione: 'admin/staff:GET', stato: 200, evento: 'db' }, errSchools)
    if (errSections) logErrore({ operazione: 'admin/staff:GET', stato: 200, evento: 'db' }, errSections)

    // Assegnazioni: solo quelle che legano un utente in scope a una classe in
    // scope. Filtrarle per uno solo dei due lati lascerebbe uscire l'altro.
    const idsUtenti = (data ?? []).map((u) => u.id as string)
    const idsSezioni = (sections ?? []).map((s) => s.id as string)
    const { data: asseg, error: errAsseg } = await supabase
      .from('utenti_sezioni')
      .select('utente_id, section_id')
      .in('utente_id', idsUtenti)
      .in('section_id', idsSezioni)
    if (errAsseg) logErrore({ operazione: 'admin/staff:GET', stato: 200, evento: 'db' }, errAsseg)

    return NextResponse.json({
      success: true,
      data: data ?? [],
      schools: schools ?? [],
      sections: sections ?? [],
      assegnazioni: asseg ?? [],
    })
  } catch (err) {
    logErrore({ operazione: 'admin/staff:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 * PATCH /api/admin/staff — l'INCARICO di un membro dello staff (DL-028).
 * Body: { id, ruolo?, scuola_id?, gradi?, section_ids? }
 *
 * ─── DUE GATE, NON UNO ──────────────────────────────────────────────────────
 *
 * Questa rotta fa quattro cose sotto un pulsante solo: ruolo, gradi, classi e
 * sede. Dal 2026-09-04 il gate di rotta ammette anche la Segreteria, ma le
 * concede la sola SEDE: la riserva sui CAMPI è il secondo gate
 * (`puoModificareIncaricoStaff`), e sta dentro l'handler perché ha bisogno del
 * ruolo del BERSAGLIO, che va letto dal database. Il perché — chi può cambiare
 * un ruolo può promuovere una collega ad `admin` e da lì rigenerarne le
 * credenziali — sta sulla testata di `src/lib/auth/incarico-staff.ts`.
 *
 * ⚠️ L'ORDINE DEI DUE GATE NON È INDIFFERENTE: prima la SEDE del bersaglio
 * (`assertUtenteInScope`), poi il suo RUOLO. Al rovescio, questa rotta
 * diventerebbe un modo per scoprire chi è `admin` in una sede che non è la
 * propria — è la stessa scelta, e per la stessa ragione, di
 * `admin/regenerate-credentials`.
 *
 * ─── LO SPOSTAMENTO DI SEDE, E COSA SI PORTA DIETRO ────────────────────────
 *
 * Fino al 2026-09-04 la sede si poteva già scrivere, ma il resto restava dov'era:
 *
 *  1. `utenti_sezioni` — il replace partiva SOLO col `section_ids` nel corpo. Il
 *     corpo minimo di uno spostamento (`{ id, scuola_id }`) lasciava in piedi le
 *     assegnazioni del plesso di partenza: un docente spostato ad Aversa restava
 *     agganciato a una sezione di Cesa, e da lì `sezioniVisibili` gli teneva
 *     aperto il registro di bambini che non sono più i suoi. 200, nessun log.
 *     Misurato in produzione il 2026-09-04: 65 righe su 51 persone.
 *  2. `utenti_scuole` — il ponte multi-plesso non veniva toccato. `staffScuola`
 *     (le notifiche) unisce `utenti.scuola_id` E il ponte PER QUALUNQUE RUOLO:
 *     una riga rimasta indietro continua a recapitare alla persona spostata gli
 *     avvisi del plesso che ha lasciato.
 *
 * ⚠️ IL PONTE SI POTA, e la sede LASCIATA se ne va anche quando era un permesso
 * dato a mano. La direzione in cui si sbaglia è voluta: una sede tolta per errore
 * è visibile (l'interessato non la vede più nel selettore) e si rimette dal
 * pannello Sedi; una sede rimasta è invisibile — per un non-admin `scuoleDiUtente`
 * la ignora del tutto — e continua a far leggere un plesso che la persona ha
 * lasciato.
 *
 * ─── L'ORDINE DELLE SCRITTURE: SI TOGLIE, SI SPOSTA, SI DÀ ─────────────────
 *
 * Le scritture stanno su tre tabelle e non c'è transazione. L'ordine è scelto in
 * modo che ogni guasto si fermi su uno stato leggibile:
 *
 *  1. si SGANCIANO le classi che non sono del plesso d'arrivo, e si pota il ponte;
 *  2. si scrive la SEDE;
 *  3. si AGGANCIANO le classi del plesso d'arrivo che il corpo ha chiesto.
 *
 * Un guasto ai punti 1-2 lascia la persona nel plesso di partenza — magari senza
 * classi, che è visibile e si rimette dalla stessa scheda — e mai nel plesso
 * nuovo ancora agganciata al vecchio, che è il difetto che questo codice chiude.
 * Il punto 3 sta DOPO la sede, e non insieme allo sgancio, per la stessa
 * ragione al rovescio: agganciare prima vorrebbe dire, se la UPDATE fallisse,
 * lasciare una persona ancora a Cesa con una classe di Aversa.
 * ═══════════════════════════════════════════════════════════════════════════ */
export const PATCH = withRoute('admin/staff:PATCH', async (request: Request) => {
  try {
    const auth = await requireStaff(request, [...SCRITTURA])
    if (auth.response) return auth.response

    const parsed = await parseBody(request, patchBodySchema)
    if ('response' in parsed) return parsed.response
    const body = parsed.data
    const id = body.id

    // self-lockout guard: non si cambia il proprio stesso ruolo
    if (body.ruolo !== undefined && id === auth.user.id) {
      return NextResponse.json({ error: 'Non puoi modificare il tuo stesso ruolo' }, { status: 403 })
    }

    // `scuola_id: null` non è una destinazione, ed è anche impossibile:
    // `utenti.scuola_id` è NOT NULL in produzione (verificato su
    // `information_schema` il 2026-09-04), quindi finora quel `null` arrivava
    // intatto alla UPDATE e tornava indietro come un 500 con la prosa di
    // PostgREST. Meglio il 400 onesto: «non mi hai detto dove» — che è
    // esattamente ciò che `SEDE_DA_SPECIFICARE` dice, in due lingue.
    if (body.scuola_id === null) return rifiutoSede('SEDE_DA_SPECIFICARE')

    const supabase = await createAdminClient()

    // Scope di sede sul BERSAGLIO. Fino al 2026-07-31 si validava soltanto la
    // sede di DESTINAZIONE (`body.scuola_id`): il gate era sul VALORE scritto e
    // non sul SOGGETTO scritto, quindi si cambiava ruolo, gradi e classi a un
    // dipendente di un altro plesso. 404 se non esiste, 403 se è di un'altra sede.
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, id)
    if (fuoriScope) return fuoriScope

    // ── Com'è messo ADESSO il bersaglio ─────────────────────────────────────
    // Serve per decidere che cosa cambia DAVVERO: la scheda del personale salva
    // il form INTERO e rimanda sempre ruolo e classi, anche quando l'operatore ha
    // toccato solo la tendina della sede.
    const { data: bersaglio, error: errBersaglio } = await supabase
      .from('utenti')
      .select('id, ruolo, scuola_id')
      .eq('id', id)
      .maybeSingle()
    if (errBersaglio) return erroreDb(OPERAZIONE_PATCH, 'db-bersaglio', errBersaglio)
    if (!bersaglio) return NextResponse.json({ error: 'Utente non trovato' }, { status: 404 })

    const sedePartenza = (bersaglio.scuola_id as string | null) ?? null
    const ruoloBersaglio = (bersaglio.ruolo as string | null) ?? null

    const { data: righeSezioni, error: errLetturaSezioni } = await supabase
      .from('utenti_sezioni')
      .select('section_id')
      .eq('utente_id', id)
    if (errLetturaSezioni) return erroreDb(OPERAZIONE_PATCH, 'db-sezioni-attuali', errLetturaSezioni)
    const sezioniAttuali = (righeSezioni ?? []).map((r) => String(r.section_id))

    // Le SEZIONI chieste dal corpo. Non-array oggi vengono ignorate in silenzio
    // (`Array.isArray`): resta così, per non respingere richieste che oggi passano.
    const sezioni = Array.isArray(body.section_ids) ? (body.section_ids as unknown[]) : null

    // ── Che cosa cambierebbe davvero ────────────────────────────────────────
    const sedeChiesta = body.scuola_id ?? null
    const trasferimento = sedeChiesta !== null
      && (!sedePartenza || formaConfronto(sedeChiesta) !== formaConfronto(sedePartenza))

    const cambi: CambiIncarico = {
      sede: trasferimento,
      ruolo: body.ruolo !== undefined && body.ruolo !== ruoloBersaglio,
      // ⚠️ `gradi` si guarda per PRESENZA e non per differenza, ed è l'unica
      // eccezione: la scheda del personale quel campo non lo manda mai (manda
      // `id`, `ruolo`, `scuola_id`, `section_ids`), quindi vederlo arrivare è un
      // atto deliberato. Il giorno in cui un'interfaccia lo rimandasse col resto
      // del form, la Segreteria si vedrebbe negare ogni salvataggio: rumoroso e
      // visibile, che è il verso giusto in cui sbagliare.
      gradi: body.gradi !== undefined,
      sezioni: sezioni !== null && !stessoInsieme(sezioni, sezioniAttuali),
    }

    // ── Il secondo gate: quali CAMPI, su CHI ────────────────────────────────
    const esito = puoModificareIncaricoStaff(auth.user, ruoloBersaglio, cambi)
    if (!esito.consentito) {
      /* `warn` → persistito: un tentativo di promuovere una collega o di toccare
       * un account di Direzione è un segnale di sicurezza e va contato. Solo
       * uuid, ruolo dell'attore e motivo: né il ruolo né il nome del bersaglio
       * (AGENTS.md regola 8). `stato` porta il motivo perché è in lista bianca —
       * sotto un nome fuori elenco uscirebbe `[redatto:str/…]`, cioè direbbe che
       * un motivo c'era, non QUALE.
       *
       * ⚠️ QUI LA VESTE NON C'È, ed è l'unica delle tre righe di questa rotta a
       * non averla. Le altre due sono righe sul TRASFERIMENTO, sorelle di quelle
       * di `trasferimento.ts`, e portano la stessa coppia: `ruolo` chi ha deciso,
       * `stato` la veste. Questa è una riga sul gate dei CAMPI, e il suo `stato`
       * è già occupato dal motivo — che è l'informazione per cui esiste. La veste
       * non si sposta sotto un nome nuovo: `redact` è a lista bianca, un nome
       * fuori elenco uscirebbe redatto, e allargare la lista bianca per un dato
       * di sola presentazione è precisamente ciò che la regola 8 vieta. */
      logEvento('auth', 'warn', {
        operazione: OPERAZIONE_PATCH,
        esito: 'incarico-riservato',
        stato: esito.motivo,
        utente: auth.user.id,
        ruolo: ruoloDecidente(auth.user),
      })
      return NextResponse.json(
        {
          error: 'Ruolo, fasce d’età e classi si cambiano dalla Direzione, come gli account di Direzione: la Segreteria può cambiare la sede',
          codice: 'INCARICO_STAFF_RISERVATO',
        },
        { status: 403 },
      )
    }

    const patch: Record<string, unknown> = {}
    if (body.ruolo !== undefined) patch.ruolo = body.ruolo
    if (Array.isArray(body.gradi)) patch.gradi = body.gradi

    /* ── LA DESTINAZIONE ─────────────────────────────────────────────────────
     * NON `scuoleDiUtente`, che era il controllo di prima: pretendeva che la sede
     * di arrivo fosse già fra quelle di chi sposta, cioè negava esattamente il
     * caso d'uso — la Direzione che manda una maestra in un plesso che non è
     * suo. La regola giusta vive in `src/lib/sedi/trasferimento.ts`: la Direzione
     * muove fra tutte le sedi REALI, la Segreteria solo dentro le proprie. Il
     * BERSAGLIO resta protetto da `assertUtenteInScope`, qui sopra: qui si decide
     * solo il DOVE. */
    let sedeArrivo: string | null = null
    if (trasferimento) {
      const dest = await destinazioniDiTrasferimento(supabase, auth.user, OPERAZIONE_PATCH)
      if (dest.error) {
        // «Vuoto» e «rotto» non sono la stessa cosa: senza l'elenco delle sedi
        // non si sposta niente, e non lo si spaccia per «destinazione non
        // consentita» — sarebbe un guasto travestito da divieto.
        return NextResponse.json(
          {
            error: 'Non è stato possibile leggere le sedi di destinazione: nessuno è stato spostato. Riprova fra poco.',
            codice: 'LETTURA_FALLITA',
          },
          { status: 500 },
        )
      }
      const consentita = destinazioneConsentita(dest.sedi, sedeChiesta)
      if (!consentita) {
        // `ruolo` = chi ha deciso, `stato` = la veste indossata: la stessa
        // coppia, e con lo stesso significato, delle righe di
        // `destinazioniDiTrasferimento` — che è la funzione appena chiamata qui
        // sopra. Due righe sullo stesso fatto devono contarsi allo stesso modo.
        logEvento('multi_sede', 'warn', {
          operazione: OPERAZIONE_PATCH,
          azione: 'trasferimento-sede',
          esito: 'trasferimento-destinazione-negata',
          utente: auth.user.id,
          ruolo: ruoloDecidente(auth.user),
          stato: auth.user.role,
          n: dest.sedi.length,
        })
        return rifiutoSede('SEDE_NON_ACCESSIBILE')
      }
      // Ciò che si scrive è il valore LETTO da `schools`, mai la stringa
      // arrivata dal client: in Postgres `uuid` è un TIPO e 'AAAA…' è lo stesso
      // valore di 'aaaa…', mentre in JavaScript sono due stringhe diverse.
      sedeArrivo = consentita.id
      patch.scuola_id = consentita.id
    }

    // Le SEZIONI si validano PRIMA di qualunque scrittura. Il replace è
    // distruttivo (delete + insert): un 403 dopo il delete lascerebbe il
    // dipendente senza classi. E senza questo controllo si assegnavano a un
    // utente le sezioni di un'altra sede — che da lì in poi `sezioniDiUtente`
    // considera legittime, propagando il difetto a tutto il registro.
    //
    // ⚠️ SU UN TRASFERIMENTO IL CONTROLLO È UN ALTRO, non è assente. Qui si
    // chiede «la sezione è fra le TUE sedi», e su uno spostamento quella domanda
    // nega il caso d'uso: la Direzione manda una maestra in un plesso che non è
    // suo, e le classi di quel plesso non sono sue per definizione. La domanda
    // giusta è «la sezione è del plesso d'ARRIVO», ed è più stretta di questa:
    // la sede d'arrivo l'ha già autorizzata `destinazioniConsentita`, il
    // bersaglio `assertUtenteInScope`, e la sezione deve stare esattamente lì.
    // Si applica più sotto, dove le sedi delle sezioni sono già state lette.
    if (sezioni && !trasferimento) {
      for (const sid of sezioni) {
        const fuori = await assertSezioneInScope(supabase, auth.user, sid as string)
        if (fuori) return fuori
      }
    }

    let sezioniSganciate = 0
    /** Classi chieste dal corpo che NON sono del plesso d'arrivo: si scartano, e si dice. */
    let sezioniScartate = 0
    let ponteRimosso = 0
    /** Le classi da AGGANCIARE nel plesso d'arrivo, nella forma canonica del DB. */
    let daAgganciare: string[] = []
    /** Come restano le classi DOPO lo spostamento: è ciò che va in `valore_dopo`. */
    let sezioniFinali: string[] | null = null

    if (trasferimento) {
      /* ── COSA SEGUE LA PERSONA, E COSA NO ──────────────────────────────────
       * Le classi del plesso lasciato NON seguono: una sezione di Cesa non
       * esiste ad Aversa, e riassegnarne una a caso — per nome, per posizione —
       * metterebbe una maestra nel registro di bambini scelti da nessuno.
       *
       * Si rimuove tutto ciò che NON è della sede d'arrivo, non solo ciò che era
       * della sede di partenza: è un superinsieme voluto, perché in produzione
       * esistono già assegnazioni verso una TERZA sede (2 righe, misurate il
       * 2026-09-04) e dopo lo spostamento sarebbero sbagliate esattamente allo
       * stesso modo. Un'assegnazione già nel plesso d'arrivo, invece, resta: lì
       * la persona ci sta andando.
       *
       * ⚠️ MA `body.section_ids` NON SI BUTTA VIA, e per un giro questo codice
       * l'ha fatto. La scheda del personale, in «Modifica», filtra le pillole
       * delle classi sulla sede scelta nella tendina (`sezioniPerSede`): chi
       * cambia plesso e spunta una classe del plesso NUOVO manda un corpo misto
       * — le vecchie, che restano spuntate ma non si vedono più, e le nuove.
       * Scartarlo tutto significava rispondere 200 senza assegnare niente, con
       * l'audit che dichiarava applicate anche quelle. Si tiene ciò che è del
       * plesso d'arrivo, si scarta il resto, e lo scarto si CONTA. */
      const arrivo = formaConfronto(sedeArrivo as string)
      const chieste = sezioni === null ? null : sezioni.map((s) => String(s))

      /* Una lettura sola per le DUE domande — «quali attuali sganciare» e «quali
       * chieste onorare» — perché sono la stessa domanda: di che sede è questa
       * classe. Due `select` sarebbero due giri sulla stessa tabella.
       *
       * ⚠️ `formaConfronto` PRIMA del `.in()`, e non è cosmetica. Gli uuid delle
       * sezioni attuali arrivano dal database (già minuscoli, è la forma in cui
       * Postgres li restituisce), quelli chiesti arrivano dal CLIENT nella forma
       * che gli pare: senza normalizzare, `new Set` terrebbe `'BBBB…'` e
       * `'bbbb…'` come due elementi e chiederebbe due volte la stessa riga.
       * Postgres li accetterebbe entrambi — `uuid` è un TIPO, e il confronto è
       * per valore — ma appoggiarsi a quella tolleranza significa mandare al
       * database una stringa nella forma scelta da chi chiama. Qui si manda la
       * forma canonica, che è anche l'unica su cui `sezioneNota` sa rispondere. */
      const daRisolvere = [...new Set([...sezioniAttuali, ...(chieste ?? [])].map(formaConfronto))]

      /* ⚠️ E SI FILTRA PER `scuola_id`, che non è una formalità del lock
       * `isolamento-sede-coverage`. Metà degli id di questo elenco arriva dal
       * CLIENT (`body.section_ids`), e una lettura di `sections` agganciata a id
       * scelti da chi chiama, senza filtro di sede, è la forma che restituisce
       * silenziosamente le righe di un altro plesso — cioè quell'inventario di
       * uuid di cui il GET qui sopra si è liberato il 2026-07-31. Al primo giro
       * questa query era senza filtro, e il lock l'ha vista.
       *
       * Il filtro è la sede d'ARRIVO, e non toglie NIENTE al risultato: una
       * sezione che non è di quel plesso non deve tornare né per essere onorata
       * (si scarta) né per essere sganciata (si sgancia lo stesso — vedi sotto).
       * Si legge soltanto ciò che si potrebbe tenere. */
      const sezioniDiArrivo = new Map<string, string>()
      if (daRisolvere.length > 0) {
        const { data: sez, error: errSez } = await supabase
          .from('sections')
          .select('id, scuola_id')
          .eq('scuola_id', sedeArrivo)
          .in('id', daRisolvere)
        if (errSez) return erroreDb(OPERAZIONE_PATCH, 'db-sedi-sezioni', errSez)
        for (const r of (sez ?? []) as { id?: unknown; scuola_id?: unknown }[]) {
          // La sede si ricontrolla comunque, invece di darla per buona dal
          // filtro: il `.eq()` è la difesa, questo è il collaudo della difesa.
          // Costano zero e sorvegliano cose diverse.
          if (typeof r.id === 'string' && typeof r.scuola_id === 'string'
            && formaConfronto(r.scuola_id) === arrivo) {
            sezioniDiArrivo.set(formaConfronto(r.id), r.id)
          }
        }
      }
      /* Ciò che non è tornato non è del plesso d'arrivo: o è di un altro plesso,
       * o non esiste affatto. Le due cose si trattano allo stesso modo, e si
       * nega ciò che non si è capito — tenere una sezione di cui nessuno sa a
       * quale plesso appartenga vorrebbe dire lasciarla addosso a una persona
       * che non lavora più lì. */
      const nelPlessoDiArrivo = (sid: string): boolean => sezioniDiArrivo.has(formaConfronto(sid))

      /* Senza `section_ids` il corpo non dice NIENTE sulle classi, e «niente» non
       * è «nessuna»: restano quelle che già stanno nel plesso d'arrivo. Con
       * `section_ids` vale il replace di sempre, ristretto al plesso d'arrivo —
       * quindi un elenco vuoto toglie tutto, che è ciò che un replace vuoto
       * significa da questa parte e dall'altra del `trasferimento`. */
      const volute = (chieste ?? sezioniAttuali).filter(nelPlessoDiArrivo)
      // Ciò che si scrive è il valore LETTO da `sections`, mai la stringa
      // arrivata dal client: in Postgres `uuid` è un TIPO e 'BBBB…' è lo stesso
      // valore di 'bbbb…', mentre in JavaScript sono due stringhe diverse.
      sezioniFinali = [...new Map(
        volute.map((sid) => [formaConfronto(sid), sezioniDiArrivo.get(formaConfronto(sid))!] as const),
      ).values()]

      if (chieste !== null) {
        // Si contano gli uuid DISTINTI: due volte la stessa classe chiesta e
        // scartata è un errore solo, e un contatore gonfiato è un contatore che
        // nessuno userà più.
        sezioniScartate = new Set(chieste.map(formaConfronto)).size - sezioniFinali.length
      }

      const restano = new Set(sezioniFinali.map(formaConfronto))
      const gia = new Set(sezioniAttuali.map(formaConfronto))
      const daSganciare = sezioniAttuali.filter((sid) => !restano.has(formaConfronto(sid)))
      daAgganciare = sezioniFinali.filter((sid) => !gia.has(formaConfronto(sid)))

      if (daSganciare.length > 0) {
        const { error: errDel } = await supabase
          .from('utenti_sezioni')
          .delete()
          .eq('utente_id', id)
          .in('section_id', daSganciare)
        if (errDel) return erroreDb(OPERAZIONE_PATCH, 'db-sgancio-classi', errDel)
        sezioniSganciate = daSganciare.length
        // La riga esce anche quando il corpo non chiedeva niente, perché è
        // comunque successo qualcosa che l'operatore non ha chiesto.
        logEvento('multi_sede', 'warn', {
          operazione: OPERAZIONE_PATCH,
          azione: 'trasferimento-sede',
          esito: 'trasferimento-classi-sganciate',
          utente: id,
          n: sezioniSganciate,
        })
      }

      /* ⚠️ INDIPENDENTE DALLA RIGA QUI SOPRA, e la differenza è tutto il punto.
       * Fino al 2026-09-04 il commento di questo blocco prometteva che le classi
       * scartate «si dicono nei log invece di scartarle in silenzio», e l'unica
       * riga esistente era quella dello SGANCIO: parte solo se c'era qualcosa da
       * sganciare, e non nomina né conta ciò che il corpo aveva chiesto. Su un
       * bersaglio senza classi — il caso più semplice — `section_ids` spariva con
       * 200 e nessuna riga da nessuna parte, cioè esattamente ciò che il
       * commento dichiarava impossibile. Un campo scartato in silenzio è il
       * difetto da cui veniamo. */
      if (sezioniScartate > 0) {
        logEvento('multi_sede', 'warn', {
          operazione: OPERAZIONE_PATCH,
          azione: 'trasferimento-sede',
          esito: 'trasferimento-classi-scartate',
          utente: id,
          n: sezioniScartate,
        })
      }

      // ── Il ponte multi-plesso della sede LASCIATA ─────────────────────────
      if (sedePartenza) {
        const { data: ponte, error: errPonte } = await supabase
          .from('utenti_scuole')
          .select('scuola_id')
          .eq('utente_id', id)
        if (errPonte) {
          const codice = (errPonte as { code?: string }).code ?? ''
          if (!TABELLA_ASSENTE.has(codice)) {
            // Un permesso negato non è «la CI non è migrata»: andare avanti
            // lascerebbe la persona spostata e ancora fra lo staff del plesso
            // che ha lasciato, che è metà del difetto.
            return erroreDb(OPERAZIONE_PATCH, 'db-ponte-sedi', errPonte)
          }
          logEvento('multi_sede', 'info', {
            operazione: OPERAZIONE_PATCH,
            azione: 'trasferimento-sede',
            esito: 'ponte-sedi-assente',
            utente: id,
          })
        } else {
          const partenza = formaConfronto(sedePartenza)
          const daPotare = ((ponte ?? []) as { scuola_id?: unknown }[])
            .filter((r) => typeof r.scuola_id === 'string' && formaConfronto(r.scuola_id) === partenza)
          if (daPotare.length > 0) {
            const { error: errPota } = await supabase
              .from('utenti_scuole')
              .delete()
              .eq('utente_id', id)
              .eq('scuola_id', sedePartenza)
            if (errPota) return erroreDb(OPERAZIONE_PATCH, 'db-potatura-ponte', errPota)
            ponteRimosso = daPotare.length
          }
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('utenti').update(patch).eq('id', id)
      if (error) return erroreDb(OPERAZIONE_PATCH, 'db-incarico', error)
    }

    // Assegnazione classi: replace completo. Solo FUORI da un trasferimento —
    // dentro uno spostamento il delete è già avvenuto prima della UPDATE, e qui
    // resta il solo aggancio (vedi il ramo sotto).
    if (sezioni && !trasferimento) {
      // PostgREST non lancia: un delete fallito lasciava in piedi le
      // assegnazioni vecchie IN SILENZIO, e l'insert successivo ci si sommava.
      const { error: errDel } = await supabase.from('utenti_sezioni').delete().eq('utente_id', id)
      if (errDel) return erroreDb(OPERAZIONE_PATCH, 'db-classi-delete', errDel)
      if (sezioni.length > 0) {
        const { error: errIns } = await supabase
          .from('utenti_sezioni')
          .insert(sezioni.map((sid) => ({ utente_id: id, section_id: sid as string })))
        if (errIns) return erroreDb(OPERAZIONE_PATCH, 'db-classi-insert', errIns)
      }
    }

    /* ── LE CLASSI DEL PLESSO D'ARRIVO, E PERCHÉ SI AGGANCIANO QUI ────────────
     * DOPO la UPDATE della sede, e non insieme allo sgancio. L'ordine di questa
     * rotta è «prima si toglie ciò che non vale più, poi si sposta, poi si dà
     * ciò che vale adesso»: un aggancio prima della UPDATE lascerebbe, se la
     * UPDATE fallisse, una persona ANCORA a Cesa con una classe di Aversa — cioè
     * il difetto che questo codice esiste per chiudere, al rovescio. Qui, un
     * insert fallito lascia la persona ad Aversa senza classi: visibile, e si
     * rimette dalla stessa scheda. */
    if (trasferimento && daAgganciare.length > 0) {
      const { error: errIns } = await supabase
        .from('utenti_sezioni')
        .insert(daAgganciare.map((sid) => ({ utente_id: id, section_id: sid })))
      if (errIns) return erroreDb(OPERAZIONE_PATCH, 'db-classi-arrivo', errIns)
    }

    if (trasferimento) {
      // Il SUCCESSO si logga: con i soli errori, «nessun log» non distingue
      // «tutto ok» da «non è mai partito niente» — ed è l'ambiguità che ha
      // nascosto per mesi il guasto delle email delle credenziali.
      logEvento('multi_sede', 'info', {
        operazione: OPERAZIONE_PATCH,
        azione: 'trasferimento-sede',
        esito: 'trasferimento-sede-eseguito',
        utente: auth.user.id,
        // `ruolo` = chi ha deciso, `stato` = la veste. Vedi `ruoloDecidente`.
        ruolo: ruoloDecidente(auth.user),
        stato: auth.user.role,
        bersaglio: id,
        sede: sedeArrivo,
        sede_precedente: sedePartenza,
        sezioni_sganciate: sezioniSganciate,
        // Le classi chieste dal corpo e non onorate perché non erano del plesso
        // d'arrivo. Sta anche in una riga sua (`trasferimento-classi-scartate`),
        // che però esce solo quando è successo: qui il conteggio c'è sempre, e
        // uno zero esplicito è ciò che distingue «non ne ha scartate» da «di
        // questa richiesta non so niente».
        sezioni_scartate: sezioniScartate,
        ponte_rimosso: ponteRimosso,
      })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'staff_rbac',
      entitaId: id,
      /* ⚠️ `azione` ha TRE valori ammessi e basta: in produzione esiste
       * `audit_scritture_docente_azione_check CHECK (azione = ANY (ARRAY
       * ['insert','update','delete']))` — riletto su `pg_constraint` il
       * 2026-09-04. Un `'trasferimento-sede'` qui passerebbe ogni test (nessun
       * finto client emula i CHECK) e in produzione produrrebbe un `23514` che
       * `logScrittura` inghiotte per progetto: la riga d'audit dell'operazione
       * più delicata di questa rotta non esisterebbe MAI. Il trasferimento si
       * riconosce da `valore_dopo`, non dall'azione. */
      azione: 'update',
      /* La sede di PARTENZA, non quella d'arrivo: `admin/audit` filtra le righe
       * per le sedi di chi guarda, e `assertUtenteInScope` garantisce che chi ha
       * spostato avesse in perimetro la partenza — non necessariamente l'arrivo
       * (la Direzione muove anche verso plessi che non sono suoi). Con la sede
       * d'arrivo la traccia sarebbe invisibile proprio a chi l'ha scritta e al
       * plesso che la persona ha lasciato. */
      scuolaId: trasferimento ? sedePartenza : auth.user.scuola_id,
      valoreDopo: trasferimento
        ? {
            ruolo: body.ruolo,
            /* ⚠️ LE SEZIONI SCRITTE, NON QUELLE CHIESTE — e per un giro qui c'è
             * stato `body.section_ids`, cioè la RICHIESTA, mentre il codice
             * accanto la scartava per intero. La riga d'audit dichiarava
             * applicate delle assegnazioni che nel database non esistevano: un
             * audit che mente è peggio di un audit assente, perché manda chi
             * indaga a cercare il guasto dove il guasto non è. Questo campo si
             * chiama `valore_dopo` e deve dire com'è messa la persona DOPO. */
            section_ids: sezioniFinali,
            trasferimento_sede: { da: sedePartenza, a: sedeArrivo },
            sezioni_sganciate: sezioniSganciate,
            // Quante classi il corpo aveva chiesto e non si sono potute onorare
            // perché non erano del plesso d'arrivo. Zero non è la stessa cosa di
            // «non ne ha chieste»: quello si legge da `section_ids`.
            sezioni_scartate: sezioniScartate,
          }
        : { ruolo: body.ruolo, scuola_id: body.scuola_id, section_ids: body.section_ids },
    })

    return NextResponse.json({ success: true, data: { id } })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_PATCH, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
