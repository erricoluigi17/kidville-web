import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { ensureParentIdentity } from '@/lib/auth/parent-identity'
import { sincronizzaLegamiRuntime } from '@/lib/anagrafiche/legami'
import { sendEmailDetailed, credentialsEmailBody } from '@/lib/email/send'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
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
 * Normalizza un nome di sezione ESATTAMENTE come il trigger DB
 * `sync_alunno_section_id()` (supabase/migrations/20260704120000_baseline.sql):
 *
 *   lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
 *
 * Cioè: via TUTTI gli spazi (non un `trim`, che lascerebbe quelli interni) e
 * minuscolo. La formula va replicata alla lettera, non "a senso": se il pre-flight
 * normalizzasse anche solo un carattere in più del trigger accetterebbe nomi che il
 * trigger poi NON risolve — e il bug tornerebbe identico (`section_id` NULL, in
 * silenzio); se ne normalizzasse uno in meno boccerebbe assegnazioni valide.
 */
function normalizzaNomeSezione(nome: unknown): string {
  return String(nome ?? '').replace(/ /g, '').toLowerCase()
}

/**
 * Codici PostgREST/Postgres che significano «qui lo schema non c'è» (il DB E2E
 * della CI non è migrato): non sono guasti, sono un ambiente diverso.
 *  42P01 tabella assente · 42703 colonna assente (SELECT) · PGRST205 tabella non
 *  in cache. Su questi il pre-flight sezione si SALTA (livello `info`): non si
 *  blocca l'iscrizione di un bambino per un problema d'infrastruttura del DB di test.
 */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST205'])

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

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  doc: z.string().optional(), // path storage → signed URL
})

// referenteIndex resta unknown: il codice accetta qualsiasi valore e usa 0
// quando non è un numero (fallback pre-esistente da preservare, niente 400).
const patchBodySchema = z.object({
  id: zUuid,
  action: z.enum(['reject', 'import']),
  assignments: z.record(z.string(), z.string()).nullish(),
  referenteIndex: z.unknown().optional(),
})

// GET: lista invii, oppure ?doc=<path> per ottenere una signed URL del documento.
export const GET = withRoute('admin/iscrizioni:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const docPath = q.data.doc
    const supabase = await createAdminClient()

    if (docPath) {
      const { data, error } = await supabase.storage
        .from('form_attachments')
        .createSignedUrl(docPath, 60 * 10) // 10 minuti
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ url: data.signedUrl })
    }

    const { data, error } = await supabase
      .from('enrollment_submissions')
      .select('*')
      .in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user))
      .order('created_at', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
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
    if (subErr || !sub) {
      return NextResponse.json({ error: 'Invio non trovato' }, { status: 404 })
    }
    const invioScuolaId = (sub as { scuola_id?: string | null }).scuola_id ?? null
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

      // Account di accesso per il referente (se ha email) — S6bis: identità
      // COMPLETA (auth.users + riga `utenti` + ponte parents.auth_user_id) via
      // helper condiviso. Il vecchio blocco creava solo auth+utenti senza ponte
      // (genitore che entrava ma non risolveva i figli) e upsertava `utenti` con
      // una colonna inesistente in prod (password_segreta → PGRST204 silenzioso)
      // rischiando pure di sovrascrivere il ruolo di uno staff omonimo.
      const adultEmail = a.email ? String(a.email) : ''
      if (isReferente && adultEmail && parentId) {
        const identita = await ensureParentIdentity(supabase, {
          id: parentId,
          auth_user_id: parentAuthId,
          emails: [adultEmail],
          first_name: a.first_name != null ? String(a.first_name) : null,
          last_name: a.last_name != null ? String(a.last_name) : null,
          phone: a.phone != null ? String(a.phone) : null,
        }, { scuolaId })
        if (identita.ok) {
          referenteUserId = identita.authUserId
          parentAuthId = identita.authUserId
          credentials = { email: adultEmail, password: identita.password ?? '(account già esistente)' }

          // Il genitore ha ORA un account: è il momento in cui i suoi legami
          // anagrafici PREESISTENTI (dedup per CF: un fratello già iscritto) possono
          // finalmente diventare righe `legame_genitori_alunni`, che è la tabella
          // interrogata dalle policy RLS di pagamenti/incassi/note. Prima non esisteva
          // un `utenti.id` da mettere in `genitore_id`. I legami di QUESTO import li
          // scrive il punto 3 qui sotto. Best-effort: logga da sé, non blocca l'import.
          await sincronizzaLegamiRuntime(supabase, parentId)

          // Invio automatico delle credenziali (solo per un account appena creato)
          if (identita.createdAuth && identita.password) {
            const invio = await sendEmailDetailed({
              to: adultEmail,
              subject: 'Le tue credenziali di accesso — Kidville',
              text: credentialsEmailBody(a.first_name != null ? String(a.first_name) : null, adultEmail, identita.password),
            })
            credentialsEmailSent = invio.ok
            if (!invio.ok) {
              warnings.push(`Email credenziali NON inviata a ${adultEmail}: ${invio.error ?? 'motivo sconosciuto'} — comunicarle manualmente al referente.`)
            }
          }
        } else if (identita.reason !== 'no_email') {
          warnings.push(`Account referente: ${identita.message}`)
        }
      }

      // Account degli adulti NON referenti: si RIUSA il ponte `parents.auth_user_id`
      // già presente (dedup per CF), non si chiama `ensureParentIdentity`.
      // Perché: `ensureParentIdentity` CREA l'account `auth.users` quando manca, e
      // l'invio credenziali qui sopra è — e deve restare — riservato al solo
      // referente. Chiamarla per tutti creerebbe account con password casuale che
      // nessuno riceverà mai: login impossibile, e nessuno se ne accorgerebbe.
      // Un adulto senza ponte semplicemente non ha un `utenti.id`, e senza quello
      // la riga in `legame_genitori_alunni` (FK su `utenti.id`) non è scrivibile.
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
          stato: 'iscritto',
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
          valoreDopo: childRecord,
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
    const { error: updErr } = await supabase
      .from('enrollment_submissions')
      .update({
        status: 'approved',
        assigned_classes: assignments,
        credentials,
        imported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (updErr) warnings.push(`Aggiornamento invio: ${updErr.message}`)

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

    return NextResponse.json({
      success: true,
      credentials,
      credentialsEmailSent,
      created_students: createdStudents,
      linked_parents: parentLinks.length,
      warnings,
    })
  } catch (err) {
    logErrore({ operazione: 'admin/iscrizioni:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Errore interno' }, { status: 500 })
  }
})
