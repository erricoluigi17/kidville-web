import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertUtenteInScope, scuoleDiUtente } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { puoEliminareStaff } from '@/lib/personale/permessi-eliminazione'
import { cancellaFascicoloPersonale } from '@/lib/personale/cancella-fascicolo'
import {
  ARCHIVIAZIONE_MANTIENE,
  TRACCE_DOCENTE,
  contaTracceDocente,
  decisioneEliminazione,
} from '@/lib/personale/tracce-docente'
import type { ConteggioVoce } from '@/lib/personale/tracce-docente'

/**
 * ELIMINA UN MEMBRO DEL PERSONALE — dicendo PRIMA che cosa succederà.
 *
 * ─── PERCHÉ UNA ROTTA NUOVA E NON `PATCH /api/admin/staff` ────────────────────
 *
 * Perché quella calcola i cambi per DIFFERENZA dentro il salvataggio del form
 * dell'incarico. Nasconderci un'eliminazione significherebbe che sbagliare una
 * tendina cancella un fascicolo con un codice fiscale dentro, senza anteprima e
 * senza conferma. Qui l'operazione ha un nome, un'anteprima e due conferme.
 *
 * ─── DUE VERBI, E PERCHÉ NON `DELETE` ─────────────────────────────────────────
 *
 * `GET` è l'anteprima; `POST` esegue. Non `DELETE`, perché l'esito può essere
 * un'ARCHIVIAZIONE — che non cancella niente — e perché un corpo su `DELETE` è
 * legale ma alcuni intermediari lo tagliano, e qui il corpo porta la conferma.
 *
 * ─── LA CORSA CHE RENDE IMPOSSIBILE «HO PREMUTO ARCHIVIA E MI HA CANCELLATO» ──
 *
 * Il `POST` RICALCOLA la decisione e la confronta con `decisioneAttesa`, cioè
 * con ciò che il client dichiara di aver letto. Se nel frattempo è cambiata —
 * una maestra ha appena firmato il suo primo appello — si risponde 409 e non si
 * tocca niente. Fidarsi di ciò che il client ha visto significherebbe eseguire
 * un'operazione diversa da quella che qualcuno ha confermato.
 */

// ⚠️ Il nome passato a `withRoute` DEVE essere un letterale, non queste
// costanti: `logging-coverage.test.ts` lo cerca con una regex e pretende che
// coincida col percorso del file. È il modo in cui quel lock garantisce che il
// nome nei log dica davvero quale route ha risposto, invece di essere un
// copiaincolla dalla route vicina. Qui restano per i log interni.
const OPERAZIONE_GET = 'admin/staff/eliminazione:GET'
const OPERAZIONE_POST = 'admin/staff/eliminazione:POST'

const getQuerySchema = z.object({ id: zUuid })

const postBodySchema = z.object({
  id: zUuid,
  /** Ciò che il client dichiara di aver letto nell'anteprima. */
  decisioneAttesa: z.enum(['cancella', 'archivia'], { error: 'Decisione non eseguibile' }),
  /**
   * `z.literal(true)` e non un booleano: un corpo che dimentica il campo, o che
   * lo manda a `false`, non deve poter eseguire per distrazione.
   */
  conferma: z.literal(true, { error: 'Conferma mancante' }),
})

/** Le sole voci che si sono accese, con la loro etichetta per l'operatore. */
function motiviLeggibili(motivi: ConteggioVoce[]) {
  const chiavi = new Map(TRACCE_DOCENTE.map((v) => [`${v.tabella}.${v.colonna}`, v.chiave]))
  return motivi.map((m) => ({
    chiave: chiavi.get(`${m.tabella}.${m.colonna}`) ?? null,
    // `null` resta `null`: a schermo si legge «non misurato», mai «0». Un
    // conteggio mancato presentato come zero è un numero falso.
    n: m.n,
  }))
}

/** Il ruolo del bersaglio, letto dal DATABASE: è su quello che si decide. */
async function ruoloBersaglio(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  id: string,
): Promise<{ ruolo: string | null; scuolaId: string | null; letto: boolean }> {
  const { data, error } = await supabase
    .from('utenti')
    .select('id, ruolo, role, scuola_id')
    .eq('id', id)
    .maybeSingle()
  if (error) return { ruolo: null, scuolaId: null, letto: false }
  const r = data as { ruolo?: string | null; role?: string | null; scuola_id?: string | null } | null
  return { ruolo: r?.ruolo ?? r?.role ?? null, scuolaId: r?.scuola_id ?? null, letto: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — l'anteprima. Sole SELECT.
// ─────────────────────────────────────────────────────────────────────────────
export const GET = withRoute('admin/staff/eliminazione:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  try {
    const supabase = await createAdminClient()
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, q.data.id)
    if (fuoriScope) return fuoriScope

    const bersaglio = await ruoloBersaglio(supabase, q.data.id)
    if (!bersaglio.letto) {
      return NextResponse.json(
        { error: 'Non è stato possibile leggere questa persona', codice: 'STAFF_ELIMINAZIONE_NON_LETTA' },
        { status: 503 },
      )
    }

    const permesso = puoEliminareStaff(auth.user, q.data.id, bersaglio.ruolo)
    if (!permesso.consentito) {
      logEvento('auth', 'warn', {
        operazione: OPERAZIONE_GET,
        esito: 'eliminazione-negata',
        tipo: permesso.motivo,
        ruolo: auth.user.role,
      })
      return rifiutoPermesso(permesso.motivo)
    }

    const esito = await contaTracceDocente(supabase, q.data.id, OPERAZIONE_GET)
    const verdetto = decisioneEliminazione(esito)

    // Che cosa c'è attaccato: servono al pannello per dire «sparisce anche il
    // fascicolo» prima che sparisca.
    const { data: anagrafica } = await supabase
      .from('anagrafica_personale')
      .select('utente_id, origine_pratica_id')
      .eq('utente_id', q.data.id)
      .maybeSingle()
    const a = anagrafica as { origine_pratica_id?: string | null } | null

    return NextResponse.json({
      success: true,
      data: {
        decisione: verdetto.decisione,
        motivi: motiviLeggibili(verdetto.motivi),
        ponteGenitore: esito.ponteGenitore,
        haAnagrafica: !!anagrafica,
        haPraticaOrigine: !!a?.origine_pratica_id,
        mantiene: ARCHIVIAZIONE_MANTIENE,
      },
    })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_GET, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’operazione', codice: 'PERSONALE_OPERAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST — l'esecuzione.
// ─────────────────────────────────────────────────────────────────────────────
export const POST = withRoute('admin/staff/eliminazione:POST', async (request: NextRequest) => {
  // ⚠️ Il gate PRIMA della lettura del corpo (lock `corpo-letto-dopo-il-gate`).
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const body = b.data

  try {
    const supabase = await createAdminClient()
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, body.id)
    if (fuoriScope) return fuoriScope

    const bersaglio = await ruoloBersaglio(supabase, body.id)
    if (!bersaglio.letto) {
      return NextResponse.json(
        { error: 'Non è stato possibile leggere questa persona', codice: 'STAFF_ELIMINAZIONE_NON_LETTA' },
        { status: 503 },
      )
    }

    const permesso = puoEliminareStaff(auth.user, body.id, bersaglio.ruolo)
    if (!permesso.consentito) {
      logEvento('auth', 'warn', {
        operazione: OPERAZIONE_POST,
        esito: 'eliminazione-negata',
        tipo: permesso.motivo,
        ruolo: auth.user.role,
      })
      return rifiutoPermesso(permesso.motivo)
    }

    // SI RICALCOLA: non ci si fida di ciò che il client ha visto.
    const esito = await contaTracceDocente(supabase, body.id, OPERAZIONE_POST)
    const verdetto = decisioneEliminazione(esito)

    if (verdetto.decisione === 'non-deciso') {
      return NextResponse.json(
        {
          error: 'Una delle verifiche non è riuscita: niente è stato modificato',
          codice: 'STAFF_ELIMINAZIONE_NON_DECISA',
        },
        { status: 503 },
      )
    }
    if (verdetto.decisione === 'profilo-doppio') {
      return NextResponse.json(
        {
          error: "Questo account è anche l'accesso di una famiglia: non si elimina",
          codice: 'STAFF_ELIMINAZIONE_PROFILO_DOPPIO',
        },
        { status: 409 },
      )
    }
    if (verdetto.decisione !== body.decisioneAttesa) {
      logEvento('anagrafica', 'warn', {
        operazione: OPERAZIONE_POST,
        esito: 'decisione-cambiata',
        entita_id: body.id,
      })
      return NextResponse.json(
        {
          error: 'Nel frattempo la situazione è cambiata: ricarica la scheda',
          codice: 'STAFF_ELIMINAZIONE_CAMBIATA',
        },
        { status: 409 },
      )
    }

    const plessi = await scuoleDiUtente(supabase, auth.user)
    return verdetto.decisione === 'cancella'
      ? await cancella(supabase, auth.user, body.id, bersaglio, plessi)
      : await archivia(supabase, auth.user, body.id, bersaglio, plessi, verdetto.motivi.length)
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_POST, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’operazione', codice: 'PERSONALE_OPERAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────

function rifiutoPermesso(motivo: string): NextResponse {
  if (motivo === 'se-stessi') {
    return NextResponse.json(
      { error: 'Non puoi eliminare o archiviare il tuo stesso account', codice: 'STAFF_ELIMINAZIONE_SE_STESSI' },
      { status: 403 },
    )
  }
  if (motivo === 'bersaglio-direzione') {
    return NextResponse.json(
      { error: 'Gli account della Direzione non si eliminano da qui', codice: 'STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE' },
      { status: 403 },
    )
  }
  if (motivo === 'bersaglio-sconosciuto') {
    return NextResponse.json(
      { error: 'Non è stato possibile leggere questa persona', codice: 'STAFF_ELIMINAZIONE_NON_LETTA' },
      { status: 503 },
    )
  }
  return NextResponse.json(
    { error: 'Operazione riservata alla Direzione', codice: 'INCARICO_STAFF_RISERVATO' },
    { status: 403 },
  )
}

/**
 * Sgancia ciò che dà POTERE, prima di togliere l'accesso.
 *
 * ⚠️ NON È COSMESI. `sezioniVisibili` legge `utenti_sezioni` e NON guarda il
 * ruolo; `staffScuola` (`src/lib/notifiche/destinatari.ts`) unisce
 * `utenti.scuola_id` e il ponte `utenti_scuole` per qualunque ruolo. Lasciare
 * quelle righe significa che un account archiviato continua a comparire fra i
 * destinatari degli avvisi interni del plesso e fra i docenti di una classe.
 * È lo stesso difetto già misurato e chiuso sul trasferimento di sede.
 */
async function sganciaPoteri(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  utenteId: string,
  plessi: string[],
  op: string,
): Promise<boolean> {
  const passi: [string, string][] = [
    ['utenti_sezioni', 'utente_id'],
    ['utenti_sezioni_materie', 'utente_id'],
    ['utenti_scuole', 'utente_id'],
    ['push_subscriptions', 'utente_id'],
  ]
  for (const [tabella, colonna] of passi) {
    const { error } = await supabase.from(tabella).delete().eq(colonna, utenteId)
    // PostgREST non lancia: si controlla il valore di ritorno.
    if (error) {
      logErrore({ operazione: op, evento: `sgancio_${tabella}` }, error)
      return false
    }
  }
  const { error: errOrario } = await supabase
    .from('orario_settimanale')
    .update({ docente_id: null })
    .eq('docente_id', utenteId)
  if (errOrario) {
    logErrore({ operazione: op, evento: 'sgancio_orario' }, errOrario)
    return false
  }
  // ⚠️ L'isolamento sta NELL'ISTRUZIONE CHE SCRIVE, non solo nel gate qualche
  // riga sopra: `task_interni` porta `scuola_id`, e una UPDATE senza quel filtro
  // toccherebbe i compiti di un altro plesso se l'id arrivasse sbagliato.
  const { error: errTask } = await supabase
    .from('task_interni')
    .update({ assigned_to: null })
    .eq('assigned_to', utenteId)
    .in('scuola_id', plessi)
  if (errTask) {
    logErrore({ operazione: op, evento: 'sgancio_task' }, errTask)
    return false
  }
  return true
}

type Bersaglio = { ruolo: string | null; scuolaId: string | null }

/** L'archiviazione: `archiviato_il` + `cessato_il` + lo sgancio dei poteri. */
async function archivia(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  attore: Parameters<typeof logScrittura>[1]['attore'],
  utenteId: string,
  bersaglio: Bersaglio,
  plessi: string[],
  nMotivi: number,
  motivoDiRipiego?: 'cancellazione-rifiutata',
): Promise<NextResponse> {
  if (!(await sganciaPoteri(supabase, utenteId, plessi, OPERAZIONE_POST))) {
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’archiviazione', codice: 'STAFF_ELIMINAZIONE_NON_DECISA' },
      { status: 503 },
    )
  }

  // CAS: si archivia solo ciò che NON è già archiviato. Zero righe = qualcuno è
  // arrivato prima, e dirlo è meglio che rispondere «fatto» due volte.
  const { data, error } = await supabase
    .from('utenti')
    .update({ archiviato_il: new Date().toISOString() })
    .eq('id', utenteId)
    .is('archiviato_il', null)
    .in('scuola_id', plessi)
    .select('id')
  if (error) {
    logErrore({ operazione: OPERAZIONE_POST, evento: 'archiviazione_utenti' }, error)
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’archiviazione', codice: 'STAFF_ELIMINAZIONE_NON_DECISA' },
      { status: 503 },
    )
  }
  if ((data ?? []).length === 0) {
    return NextResponse.json(
      { error: 'Questo account risulta già archiviato', codice: 'STAFF_GIA_ARCHIVIATO' },
      { status: 409 },
    )
  }

  // ⚠️ `cessato_il` NON è opzionale: è ciò che mette in moto
  // `gdpr/retention-personale` (12 mesi le scansioni, 10 anni il fascicolo e la
  // pratica). Senza, l'archiviazione lascerebbe una carta d'identità in tabella
  // per sempre. Un guasto qui non annulla l'archiviazione — che è già scritta e
  // vale — ma si logga a `error`, perché è un dato che smette di scadere.
  const { error: errCessato } = await supabase
    .from('anagrafica_personale')
    .update({ cessato_il: new Date().toISOString().slice(0, 10) })
    .eq('utente_id', utenteId)
    .is('cessato_il', null)
  if (errCessato) {
    logEvento(
      'gdpr',
      'error',
      { operazione: OPERAZIONE_POST, esito: 'cessazione-non-scritta', entita_id: utenteId },
      errCessato,
    )
  }

  await logScrittura(supabase, {
    attore,
    entitaTipo: 'utente_staff',
    entitaId: utenteId,
    azione: 'update',
    scuolaId: bersaglio.scuolaId,
    valorePrima: { archiviato: false, ruolo: bersaglio.ruolo },
    valoreDopo: { archiviato: true, n_tracce: nMotivi, motivo: motivoDiRipiego ?? 'archiviazione' },
  })
  logEvento('anagrafica', 'warn', {
    operazione: OPERAZIONE_POST,
    esito: 'staff-archiviato',
    entita_id: utenteId,
    sede_id: bersaglio.scuolaId,
    n_tracce: nMotivi,
    ripiego: motivoDiRipiego === 'cancellazione-rifiutata' ? true : undefined,
  })

  return NextResponse.json({
    success: true,
    data: { esito: 'archiviato', motivo: motivoDiRipiego ?? null, cessazioneScritta: !errCessato },
  })
}

/**
 * La cancellazione vera: fascicolo → poteri → account.
 *
 * ⚠️ IL RAMO DI RIPIEGO È IL PUNTO DI QUESTA FUNZIONE. Postgres può rifiutare la
 * DELETE per una FK che il registro non copriva (una tabella nuova, una riga
 * arrivata fra l'anteprima e adesso): in quel caso si ARCHIVIA e la risposta lo
 * dice. Mai «cancellato» su una cancellazione che non c'è stata.
 */
async function cancella(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  attore: Parameters<typeof logScrittura>[1]['attore'],
  utenteId: string,
  bersaglio: Bersaglio,
  plessi: string[],
): Promise<NextResponse> {
  // 1. Il fascicolo e la pratica, file per primi.
  const fascicolo = await cancellaFascicoloPersonale(supabase, utenteId, OPERAZIONE_POST)
  if (!fascicolo.ok) {
    return NextResponse.json(
      {
        error: 'Non è stato possibile togliere i documenti dall’archivio: nessun dato è stato cancellato',
        codice: 'FASCICOLO_NON_CANCELLATO',
      },
      { status: 503 },
    )
  }

  // 2. I poteri.
  if (!(await sganciaPoteri(supabase, utenteId, plessi, OPERAZIONE_POST))) {
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’operazione', codice: 'STAFF_ELIMINAZIONE_NON_DECISA' },
      { status: 503 },
    )
  }

  // 3. L'account. `utenti` va via per `utenti_id_fkey … ON DELETE CASCADE`.
  const { error } = await supabase.auth.admin.deleteUser(utenteId)
  if (error) {
    logEvento(
      'gdpr',
      'warn',
      { operazione: OPERAZIONE_POST, esito: 'eliminazione-rifiutata-si-archivia', entita_id: utenteId },
      error,
    )
    return await archivia(supabase, attore, utenteId, bersaglio, plessi, 0, 'cancellazione-rifiutata')
  }

  await logScrittura(supabase, {
    attore,
    entitaTipo: 'utente_staff',
    entitaId: utenteId,
    azione: 'delete',
    scuolaId: bersaglio.scuolaId,
    valorePrima: {
      ruolo: bersaglio.ruolo,
      n_file_rimossi: fascicolo.fileRimossi,
      pratiche_cancellate: fascicolo.praticheCancellate,
    },
  })
  logEvento('gdpr', 'warn', {
    operazione: OPERAZIONE_POST,
    esito: 'staff-cancellato',
    entita_id: utenteId,
    sede_id: bersaglio.scuolaId,
    n_file_rimossi: fascicolo.fileRimossi,
    n_file_gia_assenti: fascicolo.fileGiaAssenti,
  })

  return NextResponse.json({
    success: true,
    data: {
      esito: 'cancellato',
      fileRimossi: fascicolo.fileRimossi,
      praticheCancellate: fascicolo.praticheCancellate,
    },
  })
}
