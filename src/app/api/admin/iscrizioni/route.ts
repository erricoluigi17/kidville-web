import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { resolveScuoleAttive, resolveScuolaScrittura, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { riassuntoCampi } from '@/lib/audit/riassunto'
import { ensureParentIdentity } from '@/lib/auth/parent-identity'
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede } from '@/lib/email/contesto'
import { messaggioCredenziali } from '@/lib/email/messaggi/credenziali'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { scrubSanitariDomanda } from '@/lib/gdpr/anonimizza'
import { CONSENSI_FOTO_CANALI } from '@/lib/forms/enrollment-template'
import { LIMITE_ISCRIZIONI_DEFAULT, LIMITE_ISCRIZIONI_MAX } from '@/lib/api/paginazione'
import { normalizzaNomeSezione, SCHEMA_ASSENTE } from '@/lib/alunni/sezione'
import { z } from 'zod'
import type { EnrollmentSubmissionData, EnrollmentAdult, EnrollmentChild } from '@/types/database.types'

// Esito bloccante dell'import: impedisce di marcare l'invio 'approved' (a differenza
// dei `warnings`, non bloccanti). `dove` = "Adulto N"/"Bambino N", `messaggio` = testo it.
interface ImportError {
  dove: string
  messaggio: string
}

// Normalizza una provincia (residence/birth) alla sigla ufficiale. Rete di sicurezza per
// gli invii già in coda con la provincia PER ESTESO ("Caserta" → "CE"): senza, l'INSERT su
// parents/alunni (residence_province/birth_province varchar(2)) esplode con Postgres 22001.
//   - assente (null/undefined/'') → { ok, value:null }: la provincia è facoltativa.
//   - riconoscibile (sigla o nome per esteso) → { ok, value:<sigla> }.
//   - non riconoscibile → { ok:false, messaggio }: MAI troncare a caso (art. province.ts).
function normalizzaCampoProvincia(
  raw: unknown,
  etichetta: 'di residenza' | 'di nascita',
): { ok: true; value: string | null } | { ok: false; messaggio: string } {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: null }
  }
  const sigla = normalizzaProvincia(raw)
  if (sigla) return { ok: true, value: sigla }
  return { ok: false, messaggio: `Provincia ${etichetta} non valida: usare la sigla, es. NA` }
}

// Traduce un errore PostgREST/Postgres in un messaggio italiano per l'operatore, deducendo
// il campo dal messaggio quando possibile. Il messaggio (che può contenere valori: es. il
// dettaglio di una unique-violation) va SOLO nella risposta HTTP allo staff, MAI in `app_log`
// (dove si logga codice+campo). Ritorna anche `codice`/`campo` per il logging strutturato.
function descriviErroreDb(
  err: { code?: string; message?: string } | null,
): { messaggio: string; campo: string | null; codice: string | null } {
  const codice = err?.code ?? null
  const rawMsg = err?.message ?? 'errore sconosciuto'
  // INSERT nudo: 'column "X"'; PostgREST: "Could not find the 'X' column".
  const m = /column "?([a-z_]+)"?|'([a-z_]+)' column/i.exec(rawMsg)
  const campo = m?.[1] ?? m?.[2] ?? null
  if (codice === '22001') {
    return {
      messaggio: campo
        ? `Valore troppo lungo per il campo "${campo}": verificare i dati e riprovare.`
        : 'Un valore supera la lunghezza massima del database (controllare le province: usare la sigla, es. NA).',
      campo,
      codice,
    }
  }
  if (codice === '23505') {
    return { messaggio: `Record già presente in anagrafica${campo ? ` (campo "${campo}")` : ''}.`, campo, codice }
  }
  if (codice === '23502') {
    return { messaggio: `Manca un dato obbligatorio${campo ? `: "${campo}"` : ''}.`, campo, codice }
  }
  return { messaggio: `Creazione non riuscita: ${rawMsg}`, campo, codice }
}

/**
 * La formula del trigger e i codici di «schema assente» vivono in un posto solo
 * (`src/lib/alunni/sezione.ts`): due copie della stessa normalizzazione sono due
 * dialetti che divergono, e quando divergono il pre-flight accetta nomi che il
 * trigger poi non risolve — `section_id` NULL, in silenzio. Il lock
 * `__tests__/architecture/formula-sezione-un-posto-solo.test.ts` impedisce che
 * la copia rinasca qui.
 */

/**
 * Gate di SCOPE sull'invio (multi-sede). Fino a tre sedi (Giugliano, Aversa, Cesa)
 * questa era una IDOR silenziosa: l'invio si carica PER ID, senza filtro, e per una
 * `segreteria` `scuoleDiUtente` torna solo `utenti.scuola_id` — quindi la sede
 * dell'invio NON è "accessibile", `resolveScuolaScrittura` cadeva su
 * `accessibili.length === 1` e l'alunno veniva creato NELLA SEDE DELL'OPERATORE.
 * Nessun errore, nessun log: il bambino di Aversa finiva a Giugliano.
 *
 * Ritorna una 403 pronta (con il rimedio scritto dentro) oppure `null`.
 * Invii storici senza `scuola_id` non sono vincolati: non c'è una sede da violare.
 */
async function assertInvioInScope(
  supabase: Parameters<typeof scuoleDiUtente>[0],
  user: Parameters<typeof scuoleDiUtente>[1],
  invioScuolaId: string | null,
  azione: string,
): Promise<NextResponse | null> {
  if (!invioScuolaId) return null
  const accessibili = await scuoleDiUtente(supabase, user)
  if (accessibili.includes(invioScuolaId)) return null
  // Nel log solo uuid e metadati: mai nomi, mai email della famiglia.
  logEvento('multi_sede', 'warn', {
    operazione: 'admin/iscrizioni:PATCH',
    esito: 'invio-di-altra-sede',
    azione,
    sede_id: invioScuolaId,
  })
  return NextResponse.json(
    { error: 'Questa domanda appartiene a un\'altra sede: selezionala nel menù delle sedi per aprirla.' },
    { status: 403 },
  )
}

// Un solo messaggio per «di un'altra sede» e per «non esiste»: la risposta non
// deve dire a un estraneo se quel file c'è. La differenza vive nel log.
const DOC_NEGATO =
  'Documento non accessibile: appartiene alla domanda di un\'altra sede, oppure non è più presente.'

/**
 * Gate di SCOPE sull'ALLEGATO (multi-sede) — `?doc=<percorso>`.
 *
 * Il collaudo privacy del 2026-07-31 l'ha MISURATA in produzione, non dedotta:
 * la segreteria di Aversa chiedeva un percorso preso da una domanda di
 * Giugliano e riceveva `200 {"url": "…/object/sign/form_attachments/…"}` — e
 * quell'URL, scaricato SENZA alcuna sessione, restituiva integra la scansione
 * del documento d'identità di un bambino. Il bucket ne contiene 870.
 *
 * La causa non era lo storage: era il gate. `requireStaff` verifica CHI chiede,
 * non CHE COSA viene chiesto, e il percorso arrivava dalla query dritto a
 * `createSignedUrl` col client service-role. **Un gate deve verificare
 * l'OGGETTO, non solo il soggetto.**
 *
 * Qui il percorso si RISOLVE alla domanda che lo contiene — con `@>` (PostgREST
 * `cs`), interrogando direttamente le sole domande delle sedi accessibili — e si
 * firma solo se ne esce una riga. Due rami perché il modulo d'iscrizione ha due
 * campi `file`: il documento del minore (`data->children[]->documento_path`) e
 * quello dell'adulto (`data->adults[]->documento_path`).
 *
 * Tre scelte, tutte deliberate:
 *  · **fail-CLOSED**: se la lettura fallisce non si firma. Non sapere di chi è
 *    un documento d'identità di un minore non può voler dire consegnarlo;
 *  · **percorso che non si risolve ⇒ diniego**: un oggetto che non appartiene a
 *    nessuna domanda non ha una sede da verificare, e quindi nessuno può dire
 *    che sia suo;
 *  · **un solo messaggio** per «di un'altra sede» e «inesistente» (`DOC_NEGATO`):
 *    la risposta non deve dire all'estraneo se il file c'è.
 *
 * Ritorna una 403/503 pronta, oppure `null` se si può firmare.
 */
async function assertDocumentoInScope(
  request: NextRequest,
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: Parameters<typeof scuoleDiUtente>[1],
  docPath: string,
): Promise<NextResponse | null> {
  const sedi = await resolveScuoleAttive(request, supabase, user)
  const rami = ['children', 'adults'] as const

  // Autorizzazione: la domanda che contiene il percorso, RISTRETTA alle sedi
  // attive. Il filtro di sede sta nella STESSA query — non «da qualche parte
  // nell'handler» — perché è l'unico posto dove l'AND lo rende vero.
  for (const ramo of rami) {
    const { data, error } = await supabase
      .from('enrollment_submissions')
      // `scuola_id` oltre a `id`: serve al registro degli accessi qui sotto, che
      // deve dire in quale plesso è stato letto il documento. È una colonna che
      // questa query attraversa già (`.in('scuola_id', …)`): nessuna lettura in più.
      .select('id, scuola_id')
      .in('scuola_id', sedi)
      .contains('data', { [ramo]: [{ documento_path: docPath }] })
      .limit(1)
      .maybeSingle()
    if (error) {
      // PostgREST non lancia: ritorna `{ error }`. Qui si ferma tutto — anche
      // quando è il DB E2E non migrato: un 503 in collaudo è un fastidio, un
      // documento d'identità firmato per chi non ne ha diritto è una fuga.
      logEvento('multi_sede', 'error', {
        operazione: 'admin/iscrizioni:GET',
        esito: 'documento-non-verificabile',
        entita_tipo: 'enrollment_submissions',
        error_code: (error as { code?: string }).code ?? null,
      }, error)
      return NextResponse.json(
        { error: 'Verifica del documento non riuscita: riprovare fra poco.' },
        { status: 503 },
      )
    }
    if (data) {
      const riga = data as { id?: unknown; scuola_id?: unknown }
      // ─── IL REGISTRO DEGLI ACCESSI RIUSCITI (T06-F4) ───────────────────────
      //
      // Fino al 2026-08-03 restava una riga solo per i tentativi RESPINTI. Cioè
      // il registro rispondeva alla domanda sbagliata: quella che una famiglia ha
      // diritto di fare (art. 15 GDPR) è «chi ha visto i dati di mio figlio?», non
      // «chi ci ha provato senza riuscirci». Da qui esce una URL firmata che vive
      // 10 minuti ed è scaricabile SENZA sessione, sul documento d'identità di un
      // minore: se non resta traccia di chi l'ha chiesta, non c'è nessuna risposta
      // da dare.
      //
      // È anche la regola 5 di AGENTS.md — gli eventi critici loggano ANCHE il
      // successo: senza, «nessun log» non distingue «nessuno ha guardato» da «la
      // sorveglianza non è mai partita».
      //
      // `multi_sede` è in EVENTI_PERSISTITI: la riga finisce in `app_log` e
      // sopravvive al deploy. Un registro che vive quanto un container non è un
      // registro. E come per il diniego: MAI il percorso: contiene il nome del
      // file caricato dalla famiglia. Solo uuid, ruolo, sede e conteggi — se no il
      // registro degli accessi diventa un secondo archivio da proteggere.
      logEvento('multi_sede', 'info', {
        operazione: 'admin/iscrizioni:GET',
        esito: 'documento-firmato',
        azione: 'documento',
        utente: user.id,
        ruolo: user.role,
        sede_id: typeof riga.scuola_id === 'string' ? riga.scuola_id : null,
        sedi_attive: sedi.length,
        entita_tipo: 'enrollment_submissions',
        entita_id: typeof riga.id === 'string' ? riga.id : null,
      })
      return null
    }
  }

  // Diniego. Prima di rispondere si guarda — SOLO per il log — se quel percorso
  // esista in un'altra sede: distingue un tentativo cross-sede da un percorso
  // inventato, e senza quella distinzione il log di una fuga non si legge.
  // Legge una riga sola e la SOLA `scuola_id`: mai il `data`, che è la domanda
  // di una famiglia. Best-effort: un errore qui non cambia l'esito.
  let sedeAltrove: string | null = null
  for (const ramo of rami) {
    const { data: altrove, error: altroveErr } = await supabase
      .from('enrollment_submissions')
      .select('scuola_id')
      .contains('data', { [ramo]: [{ documento_path: docPath }] })
      .limit(1)
      .maybeSingle()
    if (altroveErr) {
      logEvento('multi_sede', 'info', {
        operazione: 'admin/iscrizioni:GET',
        esito: 'documento-origine-non-verificabile',
        entita_tipo: 'enrollment_submissions',
        error_code: (altroveErr as { code?: string }).code ?? null,
      }, altroveErr)
      break
    }
    const sede = (altrove as { scuola_id?: unknown } | null)?.scuola_id
    if (typeof sede === 'string') {
      sedeAltrove = sede
      break
    }
  }

  // Nel log solo uuid, ruolo ed esito. MAI il percorso: contiene il nome del
  // file caricato dalla famiglia, che quasi sempre è il nome di una persona.
  logEvento('multi_sede', 'warn', {
    operazione: 'admin/iscrizioni:GET',
    esito: sedeAltrove ? 'documento-fuori-sede' : 'documento-non-risolto',
    azione: 'documento',
    utente: user.id,
    ruolo: user.role,
    sede_id: sedeAltrove,
    sedi_attive: sedi.length,
  })
  return NextResponse.json({ error: DOC_NEGATO }, { status: 403 })
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * Clamp di un intero da query string, SENZA 400 e senza sorprese agli estremi.
 *
 * Non usa `Number(v) || default`: con quella formula `limit=0` diventerebbe il
 * DEFAULT, cioè un valore assurdo verrebbe premiato con la pagina intera. Qui
 * un numero c'è o non c'è: se c'è si stringe fra `min` e `max`, se non c'è (o
 * non è un numero) vale il default.
 */
const interoClampato = (def: number, min: number, max: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(Math.max(Math.trunc(n), min), max)
  }, z.number())

const getQuerySchema = z.object({
  // `max(500)` come in `pagamenti/cassa/allegato:GET`: un percorso di storage
  // non è lungo, e una stringa senza tetto è solo superficie d'attacco in più.
  doc: z.string().max(500).optional(), // path storage → signed URL
  // `?id=` — il DETTAGLIO di UNA domanda: è qui che vive il payload completo,
  // che l'elenco non porta più. `zUuid` come nella PATCH: la chiave primaria
  // di questa tabella è un uuid, e accettare stringhe libere allargherebbe la
  // superficie di una query che restituisce dati sanitari di un minore.
  id: zUuid.optional(),
  limit: interoClampato(LIMITE_ISCRIZIONI_DEFAULT, 1, LIMITE_ISCRIZIONI_MAX),
  offset: interoClampato(0, 0, Number.MAX_SAFE_INTEGER),
})

// referenteIndex resta unknown: il codice accetta qualsiasi valore e usa 0
// quando non è un numero (fallback pre-esistente da preservare, niente 400).
const patchBodySchema = z.object({
  id: zUuid,
  action: z.enum(['reject', 'import']),
  assignments: z.record(z.string(), z.string()).nullish(),
  referenteIndex: z.unknown().optional(),
})

/**
 * Ciò che la LISTA di «Moduli ricevuti» mostra davvero di una domanda: il nome
 * del primo bambino e due conteggi. Nient'altro.
 *
 * È il sostituto del `data` intero nell'elenco. La regola che lo governa è
 * quella dei log applicata alla risposta HTTP: **esce solo ciò che qualcuno
 * guarda**. Il nome del primo bambino resta perché è come l'operatore riconosce
 * la domanda in un elenco; codici fiscali, allergie, note mediche, documenti e
 * recapiti degli adulti no — quelli si vedono aprendo la domanda (`?id=`), che
 * è un gesto deliberato e uno alla volta.
 *
 * Difensiva per costruzione: `data` è un jsonb scritto da un modulo pubblico,
 * quindi può essere qualunque cosa — anche assente, se il DB E2E della CI non
 * ha la colonna e il ciclo 42703 l'ha tolta dalla proiezione.
 */
function riassumiDomanda(payload: unknown): {
  bambini: number
  adulti: number
  primo_bambino: string | null
} {
  const d = (payload ?? {}) as { children?: unknown; adults?: unknown }
  const bambini = Array.isArray(d.children) ? d.children : []
  const adulti = Array.isArray(d.adults) ? d.adults : []
  const primo = bambini[0] as { nome?: unknown; cognome?: unknown } | undefined
  const nome = [primo?.nome, primo?.cognome]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ')
  return { bambini: bambini.length, adulti: adulti.length, primo_bambino: nome || null }
}

// GET: elenco paginato (senza payload), ?id=<uuid> per il dettaglio di una
// domanda, oppure ?doc=<path> per ottenere una signed URL del documento.
export const GET = withRoute('admin/iscrizioni:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const docPath = q.data.doc
    const { limit, offset } = q.data
    const supabase = await createAdminClient()

    if (docPath) {
      // PRIMA il gate sull'oggetto, POI la firma: l'URL firmato vive 10 minuti
      // ed è scaricabile senza sessione, quindi produrlo e poi rispondere 403
      // sarebbe una fuga con un altro nome.
      const fuoriScope = await assertDocumentoInScope(request, supabase, auth.user, docPath)
      if (fuoriScope) return fuoriScope

      const { data, error } = await supabase.storage
        .from('form_attachments')
        .createSignedUrl(docPath, 60 * 10) // 10 minuti
      if (error) {
        // Un errore restituito senza log è un guasto muto: `withRoute` registra
        // l'esito della richiesta, non il motivo dello storage. Il messaggio
        // grezzo non torna al client (può contenere il percorso, e quindi il
        // nome del file della famiglia).
        logErrore({ operazione: 'admin/iscrizioni:GET', stato: 404, evento: 'storage' }, error)
        return NextResponse.json({ error: 'Documento non trovato' }, { status: 404 })
      }
      return NextResponse.json({ url: data.signedUrl })
    }

    // Proiezione ESPLICITA, non `select('*')`.
    //
    // `enrollment_submissions.credentials` è un JSONB `{email, password}` con la
    // PASSWORD IN CHIARO dell'account creato per il genitore. Con `select('*')`
    // usciva da qui a ogni apertura di «Moduli ricevuti», per chiunque abbia un
    // ruolo di staff nella sede, senza scadenza. Dal 2026-07-31 non si scrive
    // più (vedi l'update in fondo alla PATCH) e non si rilegge: per riavere una
    // password c'è `admin/regenerate-credentials`, che la rigenera lasciando
    // traccia. Anche `consents_log` resta fuori: è la prova dei consensi, la
    // legge il server nella PATCH, non serve all'elenco.
    let cols = ['id', 'scuola_id', 'data', 'status', 'assigned_classes', 'created_at']
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // Resilienza pre-migration (come in admin/students:GET): `select('*')` non
    // falliva mai, una proiezione esplicita sì. Il DB E2E della CI non è
    // migrato: colonna assente ⇒ `42703` ⇒ la si toglie e si riprova, invece di
    // restituire un 500 su un problema d'infrastruttura del DB di test.
    // Vale per entrambi i rami (elenco e dettaglio), quindi vive in un posto solo.
    async function conResilienza<T>(
      esegui: (colonne: string) => PromiseLike<{ data: T; error: { code?: string; message: string } | null; count?: number | null }>,
    ) {
      let esito = await esegui(cols.join(', '))
      let attempts = 0
      while (esito.error && (esito.error as { code?: string }).code === '42703' && attempts < 5) {
        const col = /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist/i.exec(esito.error.message)?.[1]
        if (!col || !cols.includes(col)) break
        logEvento('db', 'info', {
          operazione: 'admin/iscrizioni:GET',
          esito: 'colonna-assente-rimossa',
          campo: col,
        })
        cols = cols.filter((c) => c !== col)
        esito = await esegui(cols.join(', '))
        attempts++
      }
      return esito
    }

    // ─── DETTAGLIO: `?id=<uuid>` ────────────────────────────────────────────
    //
    // È il ramo dove il payload della domanda — nomi e codici fiscali dei
    // minori, allergie, note mediche — esce davvero, e per UNA riga alla volta:
    // quando un operatore ha aperto quella domanda, non quando ha aperto la
    // pagina. Il filtro di sede sta nella STESSA query dell'id (`AND`), non
    // «da qualche parte nell'handler»: è l'unico posto in cui è vero.
    if (q.data.id) {
      const { data: riga, error: errDettaglio } = await conResilienza((colonne) =>
        supabase
          .from('enrollment_submissions')
          .select(colonne)
          .eq('id', q.data.id as string)
          .in('scuola_id', scuole)
          .maybeSingle(),
      )
      if (errDettaglio) {
        logEvento('db', 'error', {
          operazione: 'admin/iscrizioni:GET',
          esito: 'dettaglio-non-letto',
          entita_tipo: 'enrollment_submissions',
          error_code: (errDettaglio as { code?: string }).code ?? null,
        }, errDettaglio)
        // Codice stabile, non prosa: il client traduce (`messaggioErrore`), e il
        // `message` grezzo di PostgREST — inglese, coi nomi delle colonne — resta
        // dov'è utile, cioè nel log qui sopra.
        return NextResponse.json(
          { error: 'Lettura della domanda non riuscita', codice: 'DOMANDA_NON_LETTA' },
          { status: 500 },
        )
      }
      if (!riga) {
        // Un solo messaggio per «di un'altra sede» e per «non esiste»: la
        // risposta non deve dire a un estraneo se quella domanda c'è. La
        // differenza vive nel log (uuid e conteggi soltanto, mai il payload).
        logEvento('multi_sede', 'warn', {
          operazione: 'admin/iscrizioni:GET',
          esito: 'dettaglio-non-in-scope',
          utente: auth.user.id,
          ruolo: auth.user.role,
          entita_tipo: 'enrollment_submissions',
          entita_id: q.data.id,
          sedi_attive: scuole.length,
        })
        return NextResponse.json(
          { error: 'Domanda non trovata', codice: 'DOMANDA_NON_APRIBILE' },
          { status: 404 },
        )
      }
      return NextResponse.json({ data: riga })
    }

    // ─── ELENCO: paginato, e SENZA il payload ───────────────────────────────
    //
    // Misurato in produzione il 2026-08-04: 299 domande, `data` per 329 kB, e
    // la proiezione dell'elenco 514.435 byte contro 58.012 senza `data`. Il
    // guadagno grosso però non è il peso: è che allergie e note mediche di 299
    // minori non partono più verso il browser a ogni apertura della pagina,
    // anche quando nessuno apre un dettaglio. `data` si continua a LEGGERE dal
    // database — serve al riassunto qui sotto — ma non esce di qui.
    const { data, error, count } = await conResilienza((colonne) =>
      supabase
        .from('enrollment_submissions')
        .select(colonne, { count: 'exact' })
        .in('scuola_id', scuole)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const righe = ((data ?? []) as unknown as Record<string, unknown>[]).map((riga) => {
      const { data: payload, ...resto } = riga
      return { ...resto, riassunto: riassumiDomanda(payload) }
    })
    // `total` dal `count` ESATTO, non da `righe.length`: con 1000 righe rese su
    // 1400 la lunghezza della pagina direbbe «1000», e il client non saprebbe
    // mai delle altre 400. `offset + righe.length` è solo la rete di sicurezza
    // per un DB che non abbia restituito il conteggio.
    const total = typeof count === 'number' ? count : offset + righe.length
    return NextResponse.json({ data: righe, total, limit, offset })
  } catch (err) {
    logErrore({ operazione: 'admin/iscrizioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 })
  }
})

// PATCH: rifiuto o import nelle anagrafiche.
// Body import: { id, action:'import', assignments: { [childIndex]: classe }, referenteIndex }
// Body reject: { id, action:'reject' }
export const PATCH = withRoute('admin/iscrizioni:PATCH', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, action } = b.data

    const supabase = await createAdminClient()

    // ─── L'invio si carica UNA volta, PRIMA di qualunque scrittura ─────────────
    // Vale per entrambe le azioni: `reject` aveva lo stesso buco di `import` (update
    // per id, nessun controllo di sede), e rifiutare la domanda di un'altra sede è
    // altrettanto grave che importarla.
    const { data: sub, error: subErr } = await supabase
      .from('enrollment_submissions')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    // Consenso foto dalla PROVA registrata all'invio (`consents_log`), non dal
    // payload grezzo: `data` è ciò che il client ha mandato, `consents_log` è ciò
    // che il server ha verificato e congelato. Le domande anteriori al passo
    // consensi non hanno la prova: restano a `false`, che è il default corretto —
    // un consenso che non risulta non è un consenso.
    if (subErr || !sub) {
      return NextResponse.json({ error: 'Invio non trovato' }, { status: 404 })
    }
    const invioScuolaId = (sub as { scuola_id?: string | null }).scuola_id ?? null

    // Consensi fotografici, letti dalla PROVA e non dal payload grezzo: `data` è
    // ciò che il client ha mandato, `consents_log` è ciò che il server ha
    // verificato e congelato all'invio. Le domande anteriori al passo consensi
    // non hanno la prova: restano a `false`, che è il default corretto — un
    // consenso che non risulta non è un consenso.
    //
    // ⚠️ TUTTI E TRE, non solo la galleria (privacy F4, 2026-07-31). Fino a oggi
    // qui si leggeva soltanto `consenso_foto_galleria`: sito e social — risposti
    // da 141 famiglie — non arrivavano da nessuna parte. L'elenco NON si scrive
    // a mano: viene da `CONSENSI_FOTO_CANALI`, così un quarto canale aggiunto al
    // modulo non può più nascere senza destinazione (lock nei test).
    const provaConsensi = (sub as { consents_log?: { blocchi?: { field_id?: string; accepted?: boolean }[] } | null }).consents_log
    const blocchiConsenso = provaConsensi?.blocchi ?? []
    const consensiFoto = Object.fromEntries(
      Object.entries(CONSENSI_FOTO_CANALI).map(([fieldId, colonna]) => [
        colonna,
        blocchiConsenso.some((b) => b.field_id === fieldId && b.accepted === true),
      ]),
    ) as Record<string, boolean>
    const fuoriScope = await assertInvioInScope(supabase, auth.user, invioScuolaId, action)
    if (fuoriScope) return fuoriScope

    if (action === 'reject') {
      const { data, error } = await supabase
        .from('enrollment_submissions')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'iscrizione',
        entitaId: id,
        azione: 'update',
        valoreDopo: { status: 'rejected' },
      })

      // Esito al genitore SOLO se un account esiste già (match best-effort per
      // email degli adulti dell'invio): la pre-iscrizione può essere anonima.
      try {
        const adulti = ((data as { data?: EnrollmentSubmissionData })?.data?.adults ?? []) as EnrollmentAdult[]
        const emails = adulti.map((a) => a.email).filter((e): e is string => Boolean(e))
        if (emails.length > 0) {
          const { data: utenti } = await supabase.from('utenti').select('id').in('email', emails)
          const destinatari = (utenti ?? []).map((u) => u.id as string)
          await notificaEvento(supabase, {
            tipo: 'iscrizione_esito',
            scuolaId: ((data as { scuola_id?: string })?.scuola_id as string | undefined) ?? null,
            utenteIds: destinatari,
            titolo: 'Esito domanda di iscrizione',
            corpo: 'La domanda di iscrizione non è stata accolta. Contatta la segreteria per i dettagli.',
            link: '/parent',
            entitaTipo: 'iscrizione',
            entitaId: id,
            bufferMin: 0,
          })
        }
      } catch (e) {
        // `error`, non `warn`, benché la richiesta risponda 200: la notifica non è stata
        // accodata, quindi il genitore non saprà MAI che la domanda è stata rifiutata.
        // È una scrittura persa in silenzio, e va contata.
        logEvento('notifica', 'error', {
          operazione: 'admin/iscrizioni:PATCH',
          esito: 'notifica-rifiuto-non-inviata',
          tipo: 'iscrizione_esito',
        }, e)
      }

      return NextResponse.json(data)
    }

    // action === 'import' garantito dallo schema (enum reject|import)
    const assignments: Record<string, string> = b.data.assignments || {}
    const referenteIndex: number = typeof b.data.referenteIndex === 'number' ? b.data.referenteIndex : 0

    // 1. L'invio è già caricato e verificato in scope qui sopra.
    const data = sub.data as EnrollmentSubmissionData
    // scuola_id: risolto dallo scope dell'admin (una sola sede), preferendo
    // quella dell'invio se accessibile.
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, invioScuolaId ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string
    // La sede dell'invio è accessibile (gate sopra) ma la scrittura sta andando
    // altrove: non è un abuso, ma è un import che archivia il bambino in una sede
    // diversa da quella per cui la famiglia ha fatto domanda. Deve lasciare traccia.
    if (invioScuolaId && invioScuolaId !== scuolaId) {
      logEvento('multi_sede', 'warn', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'import-sede-diversa-da-invio',
        sede_id: scuolaId,
      })
    }
    const children = data.children || []
    const adults = data.adults || []

    // Ogni figlio deve avere una classe assegnata
    for (let i = 0; i < children.length; i++) {
      if (!assignments[String(i)]) {
        return NextResponse.json({ error: `Assegnare una classe al bambino ${i + 1}` }, { status: 400 })
      }
    }

    // Bloccanti (impediscono l'approvazione) vs warnings (non bloccanti).
    const errors: ImportError[] = []
    const warnings: string[] = []

    // ─── PRE-FLIGHT province: valida TUTTI i record PRIMA di qualsiasi scrittura ───
    // Così una provincia per esteso non riconoscibile non lascia mai anagrafiche a metà:
    // niente insert parziali, l'invio resta 'pending' e l'operatore corregge e riprova.
    // Le sigle normalizzate vengono riusate negli INSERT sotto (una sola normalizzazione).
    const adultProv: { residence: string | null; birth: string | null }[] = []
    for (let ai = 0; ai < adults.length; ai++) {
      const a = adults[ai] as EnrollmentAdult
      const res = normalizzaCampoProvincia(a.residence_province, 'di residenza')
      const bir = normalizzaCampoProvincia(a.birth_province, 'di nascita')
      if (!res.ok) {
        errors.push({ dove: `Adulto ${ai + 1}`, messaggio: res.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'adulto', indice: ai + 1, campo: 'residence_province' })
      }
      if (!bir.ok) {
        errors.push({ dove: `Adulto ${ai + 1}`, messaggio: bir.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'adulto', indice: ai + 1, campo: 'birth_province' })
      }
      adultProv.push({ residence: res.ok ? res.value : null, birth: bir.ok ? bir.value : null })
    }
    const childProv: { residence: string | null; birth: string | null }[] = []
    for (let ci = 0; ci < children.length; ci++) {
      const c = children[ci] as EnrollmentChild
      const res = normalizzaCampoProvincia(c.residence_province, 'di residenza')
      const bir = normalizzaCampoProvincia(c.birth_province, 'di nascita')
      if (!res.ok) {
        errors.push({ dove: `Bambino ${ci + 1}`, messaggio: res.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'bambino', indice: ci + 1, campo: 'residence_province' })
      }
      if (!bir.ok) {
        errors.push({ dove: `Bambino ${ci + 1}`, messaggio: bir.messaggio })
        logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'provincia-non-valida', entita: 'bambino', indice: ci + 1, campo: 'birth_province' })
      }
      childProv.push({ residence: res.ok ? res.value : null, birth: bir.ok ? bir.value : null })
    }

    // ─── PRE-FLIGHT sezione: la classe assegnata esiste NELLA SEDE di scrittura? ───
    // `assignments` è TESTO e finisce in `alunni.classe_sezione`; è il trigger
    // `sync_alunno_section_id()` a risolvere `section_id`, cercando il nome dentro la
    // STESSA `scuola_id`. Se non lo trova lascia `section_id` NULL e non dice niente:
    // l'alunno risulta iscritto ma è fuori da appello, registro e classe. Con tre sedi
    // che hanno sezioni quasi omonime ("3 ANNI", "2 ANNI A") succede al primo errore di
    // tendina. Qui si controlla PRIMA di ogni scrittura, con la stessa normalizzazione
    // del trigger — niente insert parziali, l'invio resta 'pending'.
    const { data: sezioniSede, error: sezErr } = await supabase
      .from('sections')
      .select('name')
      .eq('scuola_id', scuolaId)
    if (sezErr) {
      // Il controllo si salta, l'import prosegue: il DB E2E della CI non è migrato e
      // un'iscrizione non si blocca per un problema d'infrastruttura. `info` quando è
      // schema assente (ambiente diverso), `error` negli altri casi (guasto vero).
      const codice = (sezErr as { code?: string }).code ?? null
      logEvento('db', codice && SCHEMA_ASSENTE.has(codice) ? 'info' : 'error', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'sezioni-non-leggibili',
        entita_tipo: 'sections',
        error_code: codice,
      }, sezErr)
    } else if (!Array.isArray(sezioniSede)) {
      // PostgREST senza errore torna SEMPRE un array (al più vuoto): qui la risposta
      // non è conforme, quindi non si sa nulla — e non sapere non può voler dire
      // bocciare l'iscrizione. Si salta, ma si lascia traccia.
      logEvento('db', 'warn', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'sezioni-non-leggibili',
        entita_tipo: 'sections',
        error_code: null,
      })
    } else {
      const nomiInSede = new Set(
        (sezioniSede as { name?: unknown }[]).map((s) => normalizzaNomeSezione(s?.name)),
      )
      for (let ci = 0; ci < children.length; ci++) {
        const classe = assignments[String(ci)]
        if (nomiInSede.has(normalizzaNomeSezione(classe))) continue
        errors.push({
          dove: `Bambino ${ci + 1}`,
          messaggio: `La sezione «${classe}» non esiste nella sede selezionata: scegliere una sezione della sede della domanda.`,
        })
        // Solo l'INDICE del bambino: il nome è un dato di un minore. Nemmeno il nome
        // della sezione, che in `campi` finirebbe comunque redatto (chiave fuori lista).
        logEvento('db', 'error', {
          operazione: 'admin/iscrizioni:PATCH',
          esito: 'sezione-inesistente-in-sede',
          entita: 'bambino',
          indice: ci + 1,
          sede_id: scuolaId,
        })
      }
    }

    // ─── PRE-FLIGHT dedup alunno: quel codice fiscale è di QUESTA sede? ──────────
    // La dedup per CF era GLOBALE, senza vincolo di sede. Due danni, entrambi reali:
    //
    //  1) ACCESSO. Il modulo pubblico accetta qualunque codice fiscale senza verificarlo,
    //     e il CF italiano si DEDUCE da nome, cognome, data e luogo di nascita e sesso —
    //     esattamente i dati che il genitore di un compagno di classe conosce. Se quel CF
    //     combaciava con un bambino GIÀ iscritto, la dedup riusava quel record e l'adulto
    //     della nuova domanda gli veniva agganciato: `student_parents` E
    //     `legame_genitori_alunni`. Quest'ultima è la tabella su cui fanno join le policy
    //     RLS di pagamenti/incassi/note disciplinari, ed è ciò che rende autorevole
    //     `getFigliDiGenitore`/`genitoreHasFiglio` in decine di rotte: non un difetto
    //     anagrafico, ma accesso reale ai dati di un minore altrui.
    //  2) INTEGRITÀ. L'`update` sovrascriveva `classe_sezione` con una classe di un'ALTRA
    //     sede. Il trigger `sync_alunno_section_id()` risolve il nome DENTRO la stessa
    //     `scuola_id`: non trovandolo lascia `section_id` NULL in silenzio, e il bambino
    //     sparisce dal registro della propria sede. Con «2 ANNI» e «5 ANNI» presenti sia ad
    //     Aversa sia a Cesa, l'omonimia fra sezioni non è più un'ipotesi di scuola.
    //
    // `assertInvioInScope` non copre nulla di tutto questo: guarda la sede della DOMANDA,
    // non quella del BAMBINO riusato — una segreteria resta formalmente in scope.
    // Quindi: (A) la dedup si restringe alla sede di scrittura; (B) lo stesso CF trovato
    // ALTROVE non si ignora in silenzio (è un trasferimento legittimo o un tentativo di
    // aggancio: in entrambi i casi l'import si ferma e decide una persona).
    // Sta nel PRE-FLIGHT come province e sezione, e non nel ciclo dei figli, per una
    // ragione precisa: gli adulti si scrivono PRIMA dei bambini, quindi bloccare più a
    // valle avrebbe comunque creato il `parents`, l'account e spedito le credenziali a chi
    // sta tentando l'aggancio. Qui non si scrive niente: l'invio resta 'pending'.
    const dedupCf: (string | null)[] = children.map(() => null)
    for (let ci = 0; ci < children.length; ci++) {
      const cf = (children[ci] as EnrollmentChild).codice_fiscale
      if (!cf) continue

      // (A) La dedup vera e propria, RISTRETTA alla sede: un bambino con lo stesso CF in
      // un'altra sede NON è il record da riusare in questo import.
      const { data: inSede, error: inSedeErr } = await supabase
        .from('alunni')
        .select('id')
        .eq('codice_fiscale', cf)
        .eq('scuola_id', scuolaId)
        .maybeSingle()
      if (inSedeErr) {
        // PostgREST non lancia: prima l'errore spariva (`const { data: existing }` da solo).
        // Non si boccia un'iscrizione per una lettura fallita — si prosegue senza dedup, e
        // un eventuale doppione lo intercetta l'INSERT (23505 → errore bloccante).
        const codice = (inSedeErr as { code?: string }).code ?? null
        logEvento('db', codice && SCHEMA_ASSENTE.has(codice) ? 'info' : 'error', {
          operazione: 'admin/iscrizioni:PATCH',
          esito: 'dedup-cf-non-disponibile',
          entita: 'bambino',
          indice: ci + 1,
          error_code: codice,
        }, inSedeErr)
        continue
      }
      if (inSede?.id) {
        dedupCf[ci] = inSede.id as string
        continue
      }

      // (B) Nessun record in sede: lo stesso CF esiste ALTROVE? Questa lettura non produce
      // MAI un riuso — distingue soltanto «bambino nuovo» da «bambino di un'altra sede»,
      // che fino a ieri finivano nello stesso ramo.
      const { data: altrove, error: altroveErr } = await supabase
        .from('alunni')
        .select('scuola_id')
        .eq('codice_fiscale', cf)
      if (altroveErr || !Array.isArray(altrove)) {
        // Come sopra: non sapere non può voler dire bocciare l'iscrizione. `info` quando è
        // schema assente (DB E2E della CI non migrato), `error`/`warn` altrimenti.
        const codice = (altroveErr as { code?: string } | null)?.code ?? null
        logEvento(
          'db',
          altroveErr ? (codice && SCHEMA_ASSENTE.has(codice) ? 'info' : 'error') : 'warn',
          {
            operazione: 'admin/iscrizioni:PATCH',
            esito: 'cf-altre-sedi-non-verificabile',
            entita: 'bambino',
            indice: ci + 1,
            error_code: codice,
          },
          altroveErr ?? undefined,
        )
        continue
      }
      const altraSede = (altrove as { scuola_id?: unknown }[]).find(
        (r) => typeof r?.scuola_id === 'string' && r.scuola_id !== scuolaId,
      )
      if (!altraSede) continue
      errors.push({
        dove: `Bambino ${ci + 1}`,
        messaggio:
          'Questo codice fiscale risulta già iscritto in un\'altra sede: serve un trasferimento, non una nuova iscrizione. Verificare con la sede di provenienza prima di procedere; se il codice fiscale è stato digitato male, correggerlo nella domanda.',
      })
      // Solo uuid e indice: il CF e il nome sono dati di un minore, e per giunta di un
      // minore che qui è la potenziale VITTIMA dell'aggancio. Mai in `app_log`.
      logEvento('multi_sede', 'error', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'cf-gia-iscritto-altra-sede',
        entita: 'bambino',
        indice: ci + 1,
        sede_id: scuolaId,
        sede_esistente_id: String(altraSede.scuola_id),
      })
    }

    if (errors.length > 0) {
      logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'import-bloccato-preflight', bloccanti: errors.length })
      return NextResponse.json({ success: false, errors, warnings }, { status: 200 })
    }

    let credentials: { email: string; password: string } | null = null
    let credentialsEmailSent = false
    let referenteUserId: string | null = null
    /** Quante credenziali sono partite davvero: dal 2026-08-16 può essere >1. */
    let credenzialiInviate = 0

    // 2. ADULTI → parents (dedup per CF) + account per il referente
    // `accountId` è l'`utenti.id` (spazio-id ACCOUNT) dell'adulto, quando ne ha uno:
    // serve a scrivere anche il legame runtime `legame_genitori_alunni` (vedi punto 3).
    const parentLinks: { parentId: string; accountId: string | null; role: string; isReferente: boolean }[] = []
    // Conteggi per il log riassuntivo dei legami runtime (una riga per import, non una per coppia).
    let legamiScritti = 0
    let legamiSenzaAccount = 0
    let legamiFalliti = 0

    for (let ai = 0; ai < adults.length; ai++) {
      const a = adults[ai] as EnrollmentAdult
      const isReferente = ai === referenteIndex
      let parentId: string | null = null
      let parentAuthId: string | null = null

      // Dedup per codice fiscale — DELIBERATAMENTE cross-sede, al contrario di quella dei
      // bambini qui sotto, e la differenza non è una svista: un adulto PUÒ avere figli in
      // sedi diverse (Giugliano, Aversa, Cesa sono la stessa cooperativa) ed è un caso
      // normale, mentre lo stesso bambino iscritto in due sedi non lo è. Restringere anche
      // questa alla sede creerebbe un secondo `parents` per lo stesso genitore, e con esso
      // una seconda identità: due anagrafiche, fatture intestate a metà, e — quando
      // `ensureParentIdentity` legasse l'account all'una o all'altra — un genitore che non
      // vede uno dei suoi figli. `parents` inoltre non ha nemmeno una `scuola_id` su cui
      // filtrare: la sede di un adulto è un attributo dei suoi LEGAMI, non suo.
      // Il riuso qui non concede alcun accesso da sé: l'accesso nasce dal legame
      // genitore↔alunno, ed è quello che va difeso (vedi il pre-flight sui CF dei bambini).
      if (a.fiscal_code) {
        const { data: existing } = await supabase
          .from('parents')
          .select('id, auth_user_id')
          .eq('fiscal_code', a.fiscal_code)
          .maybeSingle()
        if (existing) {
          parentId = existing.id
          parentAuthId = (existing as { auth_user_id?: string | null }).auth_user_id ?? null
        }
      }

      // Crea il genitore se non esiste (mirror di /api/admin/parents create_parent: insert senza id)
      if (!parentId) {
        const parentRecord: Record<string, unknown> = {
          first_name: a.first_name ?? null,
          last_name: a.last_name ?? null,
          fiscal_code: a.fiscal_code ?? null,
          birth_date: a.birth_date || null,
          birth_city: a.birth_place ?? null,
          birth_nation: a.birth_nation ?? null,
          citizenship: a.citizenship ?? null,
          residence_address: a.address ?? null,
          residence_street_number: a.residence_street_number ?? null,
          residence_city: a.residence_city ?? null,
          residence_province: adultProv[ai].residence,
          birth_province: adultProv[ai].birth,
          zip_code: a.zip_code ?? null,
          emails: a.email ? [a.email] : [],
          phone_numbers: a.phone ? [a.phone] : [],
          document_type: a.document_type ?? null,
          document_number: a.document_number ?? null,
          documento_path: a.documento_path ?? null,
        }
        // Insert resiliente alla colonna mancante: se il DB non ha ancora una colonna
        // del record (es. progetto E2E CI privo della migrazione 20260706105201 →
        // residence_province/residence_street_number) la rimuove e riprova. Un INSERT
        // PostgREST con colonna assente torna PGRST204 ("Could not find the 'X' column
        // ... in the schema cache"). In prod le colonne esistono → nessun retry. Senza
        // questo l'insert falliva e il `continue` sotto saltava la creazione dell'account
        // referente (credenziali mai emesse → test degrado email rosso).
        let pRes = await supabase.from('parents').insert(parentRecord).select('id').single()
        let pAttempts = 0
        while (pRes.error && ['PGRST204', '42703'].includes((pRes.error as { code?: string }).code ?? '') && pAttempts < 6) {
          const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(pRes.error.message)
          const col = m?.[1] ?? m?.[2]
          if (!col || !(col in parentRecord)) break
          delete parentRecord[col]
          pRes = await supabase.from('parents').insert(parentRecord).select('id').single()
          pAttempts++
        }
        const { data: newParent, error: pErr } = pRes
        if (pErr || !newParent) {
          // Fallimento BLOCCANTE: senza referente/adulto in anagrafica l'import non è
          // completo. Niente più degrado a `warning` con 'approved' fasullo (il bug 22001).
          const d = descriviErroreDb(pErr)
          errors.push({ dove: `Adulto ${ai + 1}`, messaggio: d.messaggio })
          logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'insert-adulto-fallito', entita: 'adulto', indice: ai + 1, campo: d.campo, codice: d.codice })
          continue
        }
        parentId = newParent.id
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'genitori',
          entitaId: parentId,
          azione: 'insert',
          scuolaId,
          valoreDopo: parentRecord,
        })
      }

      // ─── ACCOUNT DI ACCESSO PER **OGNI** ADULTO CON EMAIL ─────────────────
      //
      // Fino al 2026-08-16 questo blocco girava sotto `if (isReferente && …)`, e
      // il commento che lo seguiva dichiarava la cosa a chiare lettere: gli
      // adulti NON referenti non ricevevano un account, perché crearne uno
      // avrebbe prodotto «login impossibile, e nessuno se ne accorgerebbe» — una
      // password casuale che nessuno riceve mai.
      //
      // Il ragionamento era giusto e la conclusione è invecchiata: il difetto non
      // era l'account, era che l'email partiva al solo referente. Misurato sulle
      // 390 domande già arrivate, 100 hanno DUE genitori con un indirizzo: cento
      // persone reali — quasi sempre l'altro genitore — restavano fuori dall'app,
      // senza diario, presenze o pagamenti del proprio figlio.
      //
      // Decisione del titolare (2026-08-16): ogni genitore con un'email ha il suo
      // account e riceve le sue credenziali. `ensureParentIdentity` era già
      // idempotente: la modifica è il CICLO, non la funzione.
      //
      // Resta al REFERENTE ciò che è davvero suo e di nessun altro:
      // `intestatario_fattura` e `percentuale_pagamento` (punto 3 più sotto).
      // Chi paga è un'altra cosa da chi vede.
      const adultEmail = a.email ? String(a.email) : ''
      if (adultEmail && parentId) {
        const identita = await ensureParentIdentity(supabase, {
          id: parentId,
          auth_user_id: parentAuthId,
          emails: [adultEmail],
          first_name: a.first_name != null ? String(a.first_name) : null,
          last_name: a.last_name != null ? String(a.last_name) : null,
          phone: a.phone != null ? String(a.phone) : null,
        }, { scuolaId })
        if (identita.ok) {
          parentAuthId = identita.authUserId
          if (isReferente) {
            referenteUserId = identita.authUserId
            credentials = { email: adultEmail, password: identita.password ?? '(account già esistente)' }
          }

          // Il genitore ha ORA un account: è il momento in cui i suoi legami
          // anagrafici PREESISTENTI (dedup per CF: un fratello già iscritto) possono
          // finalmente diventare righe `legame_genitori_alunni`, che è la tabella
          // interrogata dalle policy RLS di pagamenti/incassi/note. Prima non esisteva
          // un `utenti.id` da mettere in `genitore_id`. I legami di QUESTO import li
          // scrive il punto 3 qui sotto. Best-effort: logga da sé, non blocca l'import.
          await sincronizzaLegamiRuntime(supabase, parentId)

          // Invio automatico delle credenziali (solo per un account appena creato)
          if (identita.createdAuth && identita.password) {
            // La sede nel corpo dell'email: qui è nota per certo — è quella
            // dell'iscrizione che si sta approvando, la stessa che finisce
            // sull'alunno. «Kidville» da solo, con tre plessi, non dice al
            // genitore a quale scuola sia stato iscritto suo figlio.
            const sede = await risolviContestoSede(supabase, scuolaId, 'admin/iscrizioni:POST')
            const messaggio = messaggioCredenziali({
              nome: a.first_name != null ? String(a.first_name) : null,
              email: adultEmail,
              password: identita.password,
              occasione: 'iscrizione-approvata',
            }, sede)
            const invio = await sendEmailDetailed({
              to: adultEmail,
              subject: messaggio.oggetto,
              text: messaggio.testo,
              html: messaggio.html,
            })
            if (isReferente) credentialsEmailSent = invio.ok
            if (invio.ok) {
              credenzialiInviate++
            } else {
              warnings.push(`Email credenziali NON inviata a ${adultEmail}: ${invio.error ?? 'motivo sconosciuto'} — comunicarle manualmente.`)
            }
          }
        } else if (identita.reason === 'email_conflict' && !isReferente) {
          // I due genitori hanno indicato la STESSA casella (11 domande su 390) —
          // oppure quell'indirizzo è già di un'altra anagrafica. Non è un errore
          // da correggere qui e non è un avviso da mostrare a chi approva: è la
          // realtà di quella famiglia, che condivide un accesso. `utenti.email` è
          // UNIQUE e GoTrue rifiuta un indirizzo già registrato: due account su
          // una casella sola non esistono.
          logEvento('iscrizione', 'info', {
            operazione: 'admin/iscrizioni:PATCH',
            esito: 'genitore-casella-condivisa',
            entita_id: parentId,
            sede_id: scuolaId,
          })
        } else if (identita.reason !== 'no_email') {
          warnings.push(`Account ${isReferente ? 'referente' : 'genitore'}: ${identita.message}`)
        }
      }

      if (parentId) parentLinks.push({ parentId, accountId: parentAuthId, role: a.ruolo || 'delegate', isReferente })
    }

    // 3. FIGLI → alunni (dedup per CF) + collegamento a tutti gli adulti
    const createdStudents: { id: string; nome: string }[] = []

    for (let ci = 0; ci < children.length; ci++) {
      const c = children[ci] as EnrollmentChild
      const classe = assignments[String(ci)]
      // Dedup per CF: già risolta nel PRE-FLIGHT e vincolata alla sede di scrittura. Qui
      // si usa solo l'esito, e non si rilegge: se quel CF fosse di un'altra sede l'import
      // sarebbe già stato fermato prima di qualunque scrittura.
      let studentId: string | null = dedupCf[ci] ?? null

      if (studentId) {
        await supabase.from('alunni').update({ classe_sezione: classe }).eq('id', studentId)
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'alunni',
          entitaId: studentId,
          azione: 'update',
          scuolaId,
          valoreDopo: { classe_sezione: classe },
        })
      }

      // Dedup SOFT per gli alunni SENZA codice fiscale (nome+cognome+data_nascita+scuola).
      // Il vincolo `.eq('scuola_id', scuolaId)` c'è dalla nascita di questo blocco e va
      // tenuto: è ciò che impedisce alla dedup soft lo stesso difetto che aveva quella per
      // CF (due bambini omonimi e coetanei in sedi diverse non sono lo stesso bambino).
      // Serve al RE-IMPORT dopo un fallimento parziale: senza CF non c'è chiave forte, e un
      // secondo import ricreerebbe lo stesso bambino. Guardia stretta — attiva SOLO con tutti
      // e tre i campi identificativi presenti — per non fondere per errore due bambini omonimi
      // privi di data di nascita. `limit(1)` protegge `maybeSingle` da eventuali duplicati già
      // in tabella. Se la colonna non esistesse nel DB E2E (42703) l'errore è ignorato e si
      // procede all'insert (comportamento invariato: al più un doppione in E2E, mai in prod).
      if (!studentId && !c.codice_fiscale && c.nome && c.cognome && c.data_nascita) {
        const { data: soft, error: softErr } = await supabase
          .from('alunni')
          .select('id')
          .eq('scuola_id', scuolaId)
          .eq('nome', c.nome)
          .eq('cognome', c.cognome)
          .eq('data_nascita', c.data_nascita)
          .limit(1)
          .maybeSingle()
        if (softErr) {
          logEvento('db', 'info', { operazione: 'admin/iscrizioni:PATCH', esito: 'dedup-soft-non-disponibile', entita: 'bambino', indice: ci + 1, codice: (softErr as { code?: string }).code ?? null })
        } else if (soft) {
          studentId = soft.id
          await supabase.from('alunni').update({ classe_sezione: classe }).eq('id', studentId)
          await logScrittura(supabase, {
            attore: auth.user,
            entitaTipo: 'alunni',
            entitaId: studentId,
            azione: 'update',
            scuolaId,
            valoreDopo: { classe_sezione: classe },
          })
        }
      }

      if (!studentId) {
        const childRecord: Record<string, unknown> = {
          scuola_id: scuolaId,
          nome: c.nome ?? null,
          cognome: c.cognome ?? null,
          data_nascita: c.data_nascita || null,
          gender: c.gender ?? null,
          codice_fiscale: c.codice_fiscale ?? null,
          birth_city: c.birth_city ?? null,
          birth_province: childProv[ci].birth,
          birth_nation: c.birth_nation ?? null,
          citizenship: c.citizenship ?? null,
          residence_address: c.residence_address ?? null,
          residence_street_number: c.residence_street_number ?? null,
          residence_city: c.residence_city ?? null,
          residence_province: childProv[ci].residence,
          zip_code: c.zip_code ?? null,
          allergies: c.allergies ?? null,
          note_mediche: c.note_mediche ?? null,
          documento_path: c.documento_path ?? null,
          classe_sezione: classe,
          stato: STATO_ISCRITTO,
          // Liberatorie foto raccolte al momento dell'iscrizione, UNA PER CANALE.
          // Senza queste righe la famiglia acconsentiva e il bambino restava
          // comunque a `false`: il consenso c'era, ma non era mai arrivato dove
          // viene letto. I canali NON si contaminano — la galleria riservata alle
          // famiglie della sezione è un'altra cosa dal sito pubblico e dai social
          // (provv. Garante 725 del 27/11/2025).
          ...consensiFoto,
        }
        // Insert resiliente alla colonna mancante (come per i parents sopra): DB E2E
        // senza le colonne della migrazione 20260706105201 → PGRST204 → le rimuove e riprova.
        let cRes = await supabase.from('alunni').insert(childRecord).select('id, nome').single()
        let cAttempts = 0
        while (cRes.error && ['PGRST204', '42703'].includes((cRes.error as { code?: string }).code ?? '') && cAttempts < 6) {
          const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(cRes.error.message)
          const col = m?.[1] ?? m?.[2]
          if (!col || !(col in childRecord)) break
          delete childRecord[col]
          cRes = await supabase.from('alunni').insert(childRecord).select('id, nome').single()
          cAttempts++
        }
        const { data: newChild, error: cErr } = cRes
        if (cErr || !newChild) {
          // Fallimento BLOCCANTE: un figlio non creato = iscrizione incompleta.
          const d = descriviErroreDb(cErr)
          errors.push({ dove: `Bambino ${ci + 1}`, messaggio: d.messaggio })
          logEvento('db', 'error', { operazione: 'admin/iscrizioni:PATCH', esito: 'insert-bambino-fallito', entita: 'bambino', indice: ci + 1, campo: d.campo, codice: d.codice })
          continue
        }
        studentId = newChild.id
        createdStudents.push({ id: newChild.id, nome: newChild.nome })
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'alunni',
          entitaId: studentId,
          azione: 'insert',
          scuolaId,
          // NON il record intero. Fino al 2026-08-01 qui passava `childRecord`, e
          // in `audit_scritture_docente` finiva la scheda completa del bambino —
          // nome, codice fiscale, indirizzo, allergie, note mediche — su una
          // tabella che l'oblio non toccava. L'audit deve dire CHE COSA è stato
          // creato e QUALI campi sono stati compilati, non esserne una copia.
          valoreDopo: riassuntoCampi(childRecord),
        })
      }

      // Collega tutti gli adulti a questo figlio
      for (const link of parentLinks) {
        await supabase.from('student_parents').upsert(
          {
            student_id: studentId,
            parent_id: link.parentId,
            relation_type: link.role,
            is_primary: link.isReferente,
          },
          { onConflict: 'student_id,parent_id', ignoreDuplicates: false }
        )
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'legame',
          entitaId: studentId,
          azione: 'insert',
          scuolaId,
          valoreDopo: { student_id: studentId, parent_id: link.parentId, relation_type: link.role },
        })

        // ─── Legame RUNTIME, accanto a quello anagrafico ────────────────────
        // `student_parents` vive nello spazio-id ANAGRAFICA (parents.id); galleria,
        // agenda, chat, diario e pagamenti leggono `legame_genitori_alunni`, che vive
        // nello spazio-id ACCOUNT (utenti.id). Scrivere solo la prima significava
        // importare famiglie che poi non vedevano il proprio figlio da nessuna parte.
        // `genitore_id` è un `utenti.id`: l'unico valore corretto è l'account
        // dell'adulto (ponte `parents.auth_user_id`), MAI il `parents.id`.
        if (!link.accountId) {
          legamiSenzaAccount++
          continue
        }
        const legameRecord: Record<string, unknown> = {
          genitore_id: link.accountId,
          alunno_id: studentId,
          // Intestazione fatture invariata rispetto a oggi: un solo intestatario al
          // 100% (il referente), gli altri a 0. Con i default della tabella
          // (true/100) ogni adulto sarebbe intestatario dell'intero importo.
          intestatario_fattura: link.isReferente,
          percentuale_pagamento: link.isReferente ? 100 : 0,
        }
        // `ignoreDuplicates: true` → ON CONFLICT DO NOTHING: idempotente (la PK è
        // `(genitore_id, alunno_id)`) e non sovrascrive quote/intestazione che la
        // segreteria potrebbe aver già corretto a mano su un legame esistente.
        const scriviLegame = () =>
          supabase
            .from('legame_genitori_alunni')
            .upsert(legameRecord, { onConflict: 'genitore_id,alunno_id', ignoreDuplicates: true })
        let lRes = await scriviLegame()
        // Degrado sul DB E2E CI non migrato (colonna assente → PGRST204/42703):
        // stesso schema di retry degli insert parents/alunni qui sopra.
        let lAttempts = 0
        while (lRes.error && ['PGRST204', '42703'].includes((lRes.error as { code?: string }).code ?? '') && lAttempts < 4) {
          const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(lRes.error.message)
          const col = m?.[1] ?? m?.[2]
          if (!col || !(col in legameRecord)) break
          delete legameRecord[col]
          lRes = await scriviLegame()
          lAttempts++
        }
        if (lRes.error) {
          // `warn`, non `info`: un legame runtime mancante è un genitore che, da
          // domani, non vede suo figlio in galleria/agenda/chat/diario/pagamenti.
          // Non blocca l'import (l'anagrafica è scritta e il backfill può recuperare),
          // ma deve lasciare traccia — con il codice PostgREST, non solo "è fallito".
          legamiFalliti++
          const d = descriviErroreDb(lRes.error as { code?: string; message?: string })
          logEvento('db', 'warn', {
            operazione: 'admin/iscrizioni:PATCH',
            esito: 'legame-runtime-non-scritto',
            entita_tipo: 'legame_genitori_alunni',
            error_code: d.codice,
          }, lRes.error)
          warnings.push('Legame genitore↔figlio non registrato per un adulto: il genitore potrebbe non vedere il figlio in app. Segnalare all\'assistenza.')
        } else {
          legamiScritti++
        }
      }
    }

    // Evento critico → si logga anche il SUCCESSO, in UNA riga per import (mai una
    // per coppia): senza, "nessun log" non distinguerebbe "legami scritti" da "non
    // è mai partito niente". `saltati_senza_account` dice il PERCHÉ dei mancanti:
    // sono adulti senza email e quindi senza account (non c'è alcun `utenti.id`).
    logEvento('db', legamiFalliti > 0 ? 'warn' : 'info', {
      operazione: 'admin/iscrizioni:PATCH',
      esito: 'legami-runtime',
      scritti: legamiScritti,
      saltati_senza_account: legamiSenzaAccount,
      falliti: legamiFalliti,
    })

    // 4. Esito. Se durante gli INSERT c'è stato ALMENO un errore bloccante (referente o un
    // figlio non creati), l'invio NON passa ad 'approved': resta 'pending', così l'operatore
    // vede il problema e riprova (il re-import è deduplicato per CF e, senza CF, dalla dedup
    // soft sopra). È il cuore del fix del bug 22001: prima si marcava 'approved' comunque e la
    // UI diceva "Importata" mentre in anagrafica non c'era nulla.
    if (errors.length > 0) {
      logEvento('db', 'error', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'import-incompleto',
        bloccanti: errors.length,
        creati: createdStudents.length,
        agganciati: parentLinks.length,
      })
      return NextResponse.json(
        {
          success: false,
          errors,
          warnings,
          created_students: createdStudents,
          linked_parents: parentLinks.length,
        },
        { status: 200 },
      )
    }

    // 5. Import completo → aggiorna l'invio a 'approved'.
    //
    // `credentials` NON si scrive più (2026-07-31). Era un JSONB con la password
    // IN CHIARO dell'account genitore, archiviata a tempo indeterminato e rilette
    // dalla GET qui sopra da qualunque ruolo di staff della sede. La password
    // torna nella risposta HTTP di QUESTA richiesta — l'unico momento in cui
    // l'operatore deve poterla leggere — e finisce nell'email al genitore.
    // Per riaverla dopo esiste `admin/regenerate-credentials`, che la rigenera
    // (e quindi invalida la precedente) lasciando traccia dell'operazione.
    // Insieme all'approvazione escono dalla domanda i DATI SANITARI del minore
    // (privacy F2, 2026-07-31). Allergie e note mediche sono ora in
    // `alunni.allergies` / `alunni.note_mediche` — dove le legge la cucina, dove
    // le corregge la segreteria e da dove l'oblio le cancella. La copia dentro
    // `data` è ridondante, ed è una categoria particolare (art. 9) che usciva
    // integra da `GET /api/admin/iscrizioni` a ogni apertura di «Moduli
    // ricevuti», per ogni ruolo di staff, senza scadenza.
    // Solo quei due campi: la domanda accolta resta un atto amministrativo, con
    // dentro chi ha chiesto cosa e quando. E solo QUI, dopo il ramo degli errori
    // bloccanti: se l'import non fosse riuscito, la segreteria riproverebbe su
    // una domanda già svuotata dei dati sanitari.
    const at = new Date().toISOString()
    const sanitari = scrubSanitariDomanda(data, at)
    const { error: updErr } = await supabase
      .from('enrollment_submissions')
      .update({
        status: 'approved',
        assigned_classes: assignments,
        data: sanitari.data,
        imported_at: at,
        updated_at: at,
      })
      .eq('id', id)
    if (updErr) warnings.push(`Aggiornamento invio: ${updErr.message}`)
    else if (sanitari.minoriScrubbati > 0) {
      // Evento critico → si logga anche il SUCCESSO. Solo conteggi e uuid:
      // `gdpr` è in EVENTI_PERSISTITI, quindi la riga resta in `app_log` e
      // documenta che quella copia è stata tolta (e quando).
      logEvento('gdpr', 'info', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'sanitari-rimossi-da-domanda',
        entita_tipo: 'enrollment_submissions',
        entita_id: id,
        n: sanitari.minoriScrubbati,
      })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'iscrizione',
      entitaId: id,
      azione: 'update',
      scuolaId,
      valoreDopo: { status: 'approved', created_students: createdStudents.length, linked_parents: parentLinks.length },
    })

    // Esito al referente (best-effort): domanda accolta. Solo se l'import ha
    // creato/agganciato un account utente.
    try {
      if (referenteUserId) {
        await notificaEvento(supabase, {
          tipo: 'iscrizione_esito',
          scuolaId,
          utenteIds: [referenteUserId],
          titolo: 'Iscrizione accolta',
          corpo: 'La domanda di iscrizione è stata accolta: benvenuti a Kidville!',
          link: '/parent',
          entitaTipo: 'iscrizione',
          entitaId: id,
          bufferMin: 0,
        })
      }
    } catch (e) {
      // Come sopra: l'import è andato a buon fine (200), ma il referente non riceverà
      // l'avviso di accoglimento. Notifica mai inviata = dato perduto → `error`.
      logEvento('notifica', 'error', {
        operazione: 'admin/iscrizioni:PATCH',
        esito: 'notifica-accoglimento-non-inviata',
        tipo: 'iscrizione_esito',
      }, e)
    }

    // Il SUCCESSO si logga, non solo l'errore: senza questa riga «nessuna
    // credenziale è partita» e «non le ha chieste nessuno» si somigliano. Qui il
    // numero conta davvero, perché dal 2026-08-16 può essere maggiore di uno.
    logEvento('iscrizione', 'info', {
      operazione: 'admin/iscrizioni:PATCH',
      esito: 'credenziali-inviate',
      sede_id: scuolaId,
      n: credenzialiInviate,
    })

    return NextResponse.json({
      success: true,
      credentials,
      credentialsEmailSent,
      credenzialiInviate,
      created_students: createdStudents,
      linked_parents: parentLinks.length,
      warnings,
    })
  } catch (err) {
    logErrore({ operazione: 'admin/iscrizioni:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 })
  }
})
