import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { ensureStaffIdentity, type Grado } from '@/lib/auth/staff-identity'
import { sendEmailDetailed } from '@/lib/email/send'
import { nomeSede } from '@/lib/scuole/reali'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { GRADI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { LIMITE_ISCRIZIONI_DEFAULT, LIMITE_ISCRIZIONI_MAX } from '@/lib/api/paginazione'

// =============================================================================
// IL COCKPIT DELLE CANDIDATURE INSEGNANTI — lato segreteria di `/lavora-con-noi`.
//
// `GET`   elenco · dettaglio (`?id=`) · curriculum (`?doc=`)  → staff, segreteria compresa
// `PATCH` approva | rifiuta                                    → Direzione soltanto
//
// La segreteria smista la posta e deve vedere chi si è candidato; approvare, però,
// CREA UN ACCOUNT DOCENTE — e un account docente legge l'anagrafica dei bambini.
// È la stessa linea che `admin/staff:PATCH` e `regenerate-credentials` tracciano
// già per le credenziali del personale, e qui si tiene identica.
// =============================================================================

/** La tabella, in un posto solo: il nome compare in sei query. */
const TABELLA = 'candidature_insegnanti'

/** Il bucket dove il modulo pubblico deposita il curriculum (nessun bucket nuovo). */
const BUCKET_CV = 'form_attachments'

/* ── I codici d'errore, letterali e in cima ───────────────────────────────────
 * Ogni risposta d'errore ne porta uno: il client traduce il codice, e chi lavora
 * con l'interfaccia in inglese non si ritrova la prosa italiana del server.
 * Sono i codici già dichiarati in `src/lib/ui/esito-fetch.ts` per le candidature. */
const CODICE_NON_TROVATA = 'CANDIDATURA_NON_TROVATA'
/**
 * IL GUASTO DEL COCKPIT — e non è `CANDIDATURE_NON_DISPONIBILI`.
 *
 * Quel codice è della PORTA PUBBLICA (`iscrizione/insegnanti`), e la frase che il
 * client mostra è, testualmente: «In questo momento non possiamo ricevere
 * candidature. Riprova più avanti, oppure scrivi alla segreteria della scuola» —
 * scritta per chi si candida, con dentro un consiglio che, mostrato qui, la
 * segreteria darebbe a sé stessa. Peggio: la sua documentazione dichiara che il
 * modulo è chiuso dalla Scuola e che riprovare non serve a niente, mentre in
 * questi rami riprovare è ESATTAMENTE ciò che serve.
 *
 * Qui il fatto è un altro: la lettura o la scrittura del cockpit non è riuscita.
 */
const CODICE_OPERAZIONE_NON_RIUSCITA = 'CANDIDATURE_OPERAZIONE_NON_RIUSCITA'
const CODICE_GIA_EVASA = 'CANDIDATURA_GIA_EVASA'
const CODICE_EMAIL_GIA_STAFF = 'CANDIDATURA_EMAIL_GIA_STAFF'
const CODICE_EMAIL_GIA_GENITORE = 'CANDIDATURA_EMAIL_GIA_GENITORE'

/**
 * UN SOLO messaggio per «non esiste» e per «è di un'altra sede».
 *
 * Distinguerli direbbe a chi non ha titolo di vederla che quella candidatura c'è
 * — e da lì escono il recapito e il curriculum di una persona che quasi sempre
 * sta lavorando altrove. La differenza vive nel log, dove la legge solo chi ha
 * accesso ai log.
 */
const NON_TROVATA = 'Candidatura non accessibile: non esiste, oppure appartiene a un\'altra sede.'
const nonTrovata = () => NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: 404 })

/** Stesso messaggio del 404, ma sull'ALLEGATO: un curriculum non si conferma. */
const docNegato = () =>
  NextResponse.json({ error: NON_TROVATA, codice: CODICE_NON_TROVATA }, { status: 403 })

/**
 * «Adesso non si può»: schema non ancora migrato (DB della CI), lettura o
 * scrittura fallita. **503 e non 200 con una lista vuota**: un elenco vuoto è una
 * risposta, e sarebbe una risposta falsa — la segreteria concluderebbe che non si
 * è candidato nessuno.
 */
const nonDisponibile = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: CODICE_OPERAZIONE_NON_RIUSCITA }, { status: 503 })

const giaEvasa = () =>
  NextResponse.json(
    {
      error: 'Questa candidatura è già stata valutata: ricaricare la pagina per vedere l\'esito aggiornato.',
      codice: CODICE_GIA_EVASA,
    },
    { status: 409 },
  )

/** Codici con cui PostgREST/Postgres dicono «questa TABELLA qui non c'è». */
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])
/** …e «questa COLONNA qui non c'è». */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

const codiceDi = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null
const colonnaMancante = (messaggio: string): string | null => {
  const m =
    /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist|Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(
      messaggio,
    )
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null
}

/**
 * L'ELENCO È POVERO, e non è un'ottimizzazione: è la stessa lezione di «Moduli
 * ricevuti» (`ModuliRicevuti.tsx:33-42`), dove il payload completo di 299 domande
 * — codici fiscali di minori, allergie, note mediche — partiva verso il browser di
 * ogni membro dello staff a ogni apertura della pagina, anche senza aprire niente.
 *
 * Qui in lista escono solo i campi che servono a RICONOSCERE una candidatura:
 * chi è, per quali fasce, in quale stato, di quando. Email, telefono, titolo di
 * studio, presentazione e curriculum arrivano con `?id=`, cioè quando qualcuno
 * apre QUELLA candidatura: un gesto deliberato, e uno alla volta.
 */
const COLONNE_ELENCO = ['id', 'scuola_id', 'stato', 'nome', 'cognome', 'gradi', 'creata_il']

/** Il dettaglio: proiezione ESPLICITA (mai `select('*')`), una candidatura alla volta. */
const COLONNE_DETTAGLIO = [
  'id', 'scuola_id', 'stato', 'nome', 'cognome', 'email', 'telefono',
  'residence_city', 'residence_province', 'gradi', 'titolo_studio', 'titolo_dettaglio',
  'anni_esperienza', 'disponibilita', 'note', 'cv_path', 'consents_log',
  'creata_il', 'aggiornata_il', 'evasa_il', 'evasa_da', 'utente_id', 'motivo_rifiuto',
]

/** Le colonne che servono per DECIDERE (approvare o rifiutare). */
const COLONNE_LAVORO = 'id, scuola_id, stato, nome, cognome, email, telefono, gradi'

/**
 * Clamp di un intero da query string, senza 400 e senza sorprese agli estremi —
 * gemello di quello di `admin/iscrizioni:GET` (là è inline: non è esportato).
 * `limit=0` non deve diventare il default, cioè la pagina intera.
 */
const interoClampato = (def: number, min: number, max: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(Math.max(Math.trunc(n), min), max)
  }, z.number())

const getQuerySchema = z.object({
  // Un percorso di storage non è lungo: una stringa senza tetto è solo
  // superficie d'attacco in più (stesso tetto di `pagamenti/cassa/allegato:GET`).
  doc: z.string().max(500).optional(),
  id: zUuid.optional(),
  limit: interoClampato(LIMITE_ISCRIZIONI_DEFAULT, 1, LIMITE_ISCRIZIONI_MAX),
  offset: interoClampato(0, 0, Number.MAX_SAFE_INTEGER),
})

const patchBodySchema = z.object({
  id: zUuid,
  action: z.enum(['approva', 'rifiuta']),
  /** Nota INTERNA: resta in tabella, non esce nell'email e non entra nei log. */
  motivo: z.string().max(2000).optional(),
  inviaEmailEsito: z.boolean().optional(),
})

/** Le fasce ammesse, dall'unico posto che le dichiara (enum `school_type_enum`). */
const GRADI_AMMESSI = new Set(GRADI_OPTIONS.map((o) => String(o.value)))

/** Le fasce della candidatura, ripulite: un valore fuori enum prende `22P02` all'INSERT. */
function gradiValidi(grezzi: unknown): Grado[] {
  if (!Array.isArray(grezzi)) return []
  return [...new Set(grezzi.map((g) => String(g)).filter((g) => GRADI_AMMESSI.has(g)))] as Grado[]
}

// ─── GET ─────────────────────────────────────────────────────────────────────
export const GET = withRoute('admin/candidature-insegnanti:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ elenco vuoto: `.in()` incondizionato, mai `if (scuole.length)`.
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // ─── IL CURRICULUM: `?doc=<percorso>` ─────────────────────────────────────
    if (q.data.doc) {
      const docPath = q.data.doc
      // PRIMA il gate sull'OGGETTO, POI la firma. Una signed URL vive dieci
      // minuti ed è scaricabile SENZA sessione: produrla e poi rispondere 403
      // sarebbe una fuga con un altro nome (è il difetto misurato in produzione
      // il 2026-07-31 sui documenti d'identità dei bambini).
      const fuoriScope = await assertCurriculumInScope(supabase, auth.user, scuole, docPath)
      if (fuoriScope) return fuoriScope

      const { data, error } = await supabase.storage.from(BUCKET_CV).createSignedUrl(docPath, 60 * 10)
      if (error || !data?.signedUrl) {
        // UN GUASTO NON SI VESTE DA DINIEGO. Qui il gate di sede è GIÀ passato:
        // quel curriculum è della sede giusta e chi guarda ne ha titolo. Se lo
        // storage non risponde, la risposta vera è «adesso non si può, riprova»
        // (503) — non «non esiste, oppure è di un'altra sede» (403), che manderebbe
        // la segreteria a cercare un problema di permessi che non c'è. È la stessa
        // dottrina di `leggiFallita` trenta righe più sotto, e prima di oggi era
        // l'unico ramo del file che non la seguiva.
        //
        // Lo `stato` loggato è quello RESTITUITO: prima diceva 404 mentre la
        // risposta era 403, e chi legge `app_log` cercava un numero mai uscito.
        // Il messaggio grezzo NON torna al client: contiene il percorso, cioè il
        // nome del file caricato dalla persona.
        logErrore({ operazione: 'admin/candidature-insegnanti:GET', stato: 503, evento: 'storage' }, error)
        return NextResponse.json(
          {
            error: 'Il curriculum non è scaricabile in questo momento: riprovare fra poco.',
            codice: CODICE_OPERAZIONE_NON_RIUSCITA,
          },
          { status: 503 },
        )
      }
      return NextResponse.json({ url: data.signedUrl })
    }

    // ─── IL DETTAGLIO: `?id=<uuid>` ───────────────────────────────────────────
    if (q.data.id) {
      const idCandidatura = q.data.id
      const { data: riga, error } = await conResilienza(COLONNE_DETTAGLIO, 'admin/candidature-insegnanti:GET', (colonne) =>
        supabase
          .from(TABELLA)
          .select(colonne)
          // Il filtro di sede sta nella STESSA query dell'id (AND), non «da
          // qualche parte nell'handler»: è l'unico posto in cui è vero.
          .eq('id', idCandidatura)
          .in('scuola_id', scuole)
          .maybeSingle(),
      )
      if (error) return leggiFallita('admin/candidature-insegnanti:GET', 'dettaglio-non-letto', error)
      if (!riga) {
        logEvento('multi_sede', 'warn', {
          operazione: 'admin/candidature-insegnanti:GET',
          esito: 'dettaglio-non-in-scope',
          utente: auth.user.id,
          ruolo: auth.user.role,
          entita_tipo: TABELLA,
          entita_id: idCandidatura,
          sedi_attive: scuole.length,
        })
        return nonTrovata()
      }
      return NextResponse.json({ data: riga })
    }

    // ─── L'ELENCO ─────────────────────────────────────────────────────────────
    const { limit, offset } = q.data
    const { data, error, count } = await conResilienza(COLONNE_ELENCO, 'admin/candidature-insegnanti:GET', (colonne) =>
      supabase
        .from(TABELLA)
        .select(colonne, { count: 'exact' })
        .in('scuola_id', scuole)
        .order('creata_il', { ascending: false })
        .range(offset, offset + limit - 1),
    )
    if (error) return leggiFallita('admin/candidature-insegnanti:GET', 'elenco-non-letto', error)

    const righe = (data ?? []) as unknown as Record<string, unknown>[]
    // `total` dal conteggio ESATTO: con 60 righe su 200 la lunghezza della pagina
    // direbbe «60», e nessuno saprebbe delle altre 140.
    const total = typeof count === 'number' ? count : offset + righe.length
    return NextResponse.json({ data: righe, total, limit, offset })
  } catch (err) {
    logErrore({ operazione: 'admin/candidature-insegnanti:GET', stato: 503 }, err)
    return nonDisponibile('Le candidature non sono consultabili in questo momento: riprovare fra poco.')
  }
})

// ─── PATCH ───────────────────────────────────────────────────────────────────
export const PATCH = withRoute('admin/candidature-insegnanti:PATCH', async (request: NextRequest) => {
  // Direzione soltanto: approvare crea un account che legge l'anagrafica dei bambini.
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, action } = b.data
    const motivo = (b.data.motivo ?? '').trim() || null
    const inviaEmailEsito = b.data.inviaEmailEsito === true

    const supabase = await createAdminClient()
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    // La candidatura si carica UNA volta, PRIMA di qualunque scrittura, e già
    // ristretta alle sedi attive: «di un'altra sede» e «non esiste» escono dalla
    // stessa porta.
    const { data: cand, error: errCand } = await supabase
      .from(TABELLA)
      .select(COLONNE_LAVORO)
      .eq('id', id)
      .in('scuola_id', scuole)
      .maybeSingle()
    if (errCand) return leggiFallita('admin/candidature-insegnanti:PATCH', 'candidatura-non-letta', errCand)
    if (!cand) {
      logEvento('multi_sede', 'warn', {
        operazione: 'admin/candidature-insegnanti:PATCH',
        esito: 'candidatura-non-in-scope',
        azione: action,
        utente: auth.user.id,
        ruolo: auth.user.role,
        entita_tipo: TABELLA,
        entita_id: id,
        sedi_attive: scuole.length,
      })
      return nonTrovata()
    }
    const riga = cand as unknown as CandidaturaDiLavoro

    return action === 'approva'
      ? await approva(supabase, auth.user, scuole, riga)
      : await rifiuta(supabase, auth.user, scuole, riga, motivo, inviaEmailEsito)
  } catch (err) {
    logErrore({ operazione: 'admin/candidature-insegnanti:PATCH', stato: 503 }, err)
    return nonDisponibile('Non è stato possibile evadere la candidatura: riprovare fra poco.')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Gli aiutanti
// ─────────────────────────────────────────────────────────────────────────────

interface CandidaturaDiLavoro {
  id: string
  scuola_id: string
  stato: string
  nome: string | null
  cognome: string | null
  email: string | null
  telefono: string | null
  gradi: unknown
}

type EsitoQuery<T> = { data: T; error: { code?: string; message: string } | null; count?: number | null }

/**
 * Resilienza alla COLONNA assente (`42703`/`PGRST204`): il progetto E2E della CI
 * non è migrato, e una proiezione esplicita — al contrario di `select('*')` —
 * fallisce. Si toglie la colonna che il database dichiara di non avere e si
 * riprova, lasciando una riga che la NOMINA (in `msg`, che finisce in chiaro
 * nella colonna `app_log.messaggio`: `redact` è a lista bianca per chiave).
 *
 * La TABELLA assente non è qui: quella non si degrada, si dichiara (503).
 */
async function conResilienza<T>(
  colonneIniziali: string[],
  operazione: string,
  esegui: (colonne: string) => PromiseLike<EsitoQuery<T>>,
): Promise<EsitoQuery<T>> {
  let colonne = [...colonneIniziali]
  let esito = await esegui(colonne.join(', '))
  let tentativi = 0
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 6) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !colonne.includes(col)) break
    logEvento('candidatura', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA,
      error_code: codiceDi(esito.error),
      msg: `colonna assente, rimossa dalla proiezione: ${col}`,
    })
    colonne = colonne.filter((c) => c !== col)
    esito = await esegui(colonne.join(', '))
    tentativi++
  }
  return esito
}

/**
 * Una lettura fallita NON è «non trovata»: i due hanno rimedi opposti — la prima
 * si risolve riprovando, la seconda no — e rispondere 404 su un guasto significa
 * affermare qualcosa su un dato che non si è letto.
 */
function leggiFallita(operazione: string, esito: string, error: unknown): NextResponse {
  const codice = codiceDi(error)
  const schemaAssente = TABELLA_ASSENTE.has(codice ?? '')
  logEvento('candidatura', schemaAssente ? 'warn' : 'error', {
    operazione,
    esito: schemaAssente ? 'tabella-assente' : esito,
    entita_tipo: TABELLA,
    error_code: codice,
  }, error)
  return nonDisponibile(
    schemaAssente
      ? 'Le candidature non sono disponibili su questo ambiente: la tabella non è ancora stata creata.'
      : 'Le candidature non sono consultabili in questo momento: riprovare fra poco.',
  )
}

/**
 * GATE SULL'OGGETTO per `?doc=` — il percorso si RISOLVE alla candidatura che lo
 * contiene, interrogando le sole sedi attive, e si firma solo se ne esce una riga.
 *
 * Tre scelte, tutte deliberate e tutte già pagate altrove in questo repo:
 *  · fail-CLOSED: se la lettura fallisce non si firma. Non sapere di chi è un
 *    curriculum non può voler dire consegnarlo;
 *  · percorso che non si risolve ⇒ diniego: un file che non appartiene a nessuna
 *    candidatura non ha una sede da verificare, quindi nessuno può dire che sia suo;
 *  · un solo messaggio per «di un'altra sede» e «inesistente».
 */
async function assertCurriculumInScope(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  docPath: string,
): Promise<NextResponse | null> {
  const { data, error } = await supabase
    .from(TABELLA)
    .select('id, scuola_id')
    .eq('cv_path', docPath)
    .in('scuola_id', scuole)
    .limit(1)
    .maybeSingle()
  if (error) {
    logEvento('multi_sede', 'error', {
      operazione: 'admin/candidature-insegnanti:GET',
      esito: 'curriculum-non-verificabile',
      entita_tipo: TABELLA,
      error_code: codiceDi(error),
    }, error)
    return nonDisponibile('Verifica del curriculum non riuscita: riprovare fra poco.')
  }
  if (data) {
    const trovata = data as { id?: unknown; scuola_id?: unknown }
    // IL REGISTRO DEGLI ACCESSI RIUSCITI. `multi_sede` è persistito: la riga resta
    // in `app_log` e sopravvive al deploy. Senza, «nessun log» non distingue
    // «nessuno ha guardato» da «la sorveglianza non è mai partita» — e da qui esce
    // un curriculum, cioè un dato personale su cui l'interessata ha diritto di
    // chiedere chi l'ha letto. MAI il percorso: contiene il nome del file, che
    // quasi sempre è il nome di una persona.
    logEvento('multi_sede', 'info', {
      operazione: 'admin/candidature-insegnanti:GET',
      esito: 'curriculum-firmato',
      azione: 'documento',
      utente: user.id,
      ruolo: user.role,
      sede_id: typeof trovata.scuola_id === 'string' ? trovata.scuola_id : null,
      sedi_attive: scuole.length,
      entita_tipo: TABELLA,
      entita_id: typeof trovata.id === 'string' ? trovata.id : null,
    })
    return null
  }

  // Diniego. Solo PER IL LOG si guarda se quel percorso esista in un'altra sede:
  // distingue un tentativo cross-sede da un percorso inventato, e senza quella
  // distinzione il log di una fuga non si legge. Best-effort: legge una riga e la
  // sola `scuola_id`, e un errore qui non cambia l'esito.
  let sedeAltrove: string | null = null
  const { data: altrove, error: errAltrove } = await supabase
    .from(TABELLA)
    .select('scuola_id')
    .eq('cv_path', docPath)
    .limit(1)
    .maybeSingle()
  if (errAltrove) {
    logEvento('multi_sede', 'info', {
      operazione: 'admin/candidature-insegnanti:GET',
      esito: 'curriculum-origine-non-verificabile',
      entita_tipo: TABELLA,
      error_code: codiceDi(errAltrove),
    }, errAltrove)
  } else {
    const sede = (altrove as { scuola_id?: unknown } | null)?.scuola_id
    if (typeof sede === 'string') sedeAltrove = sede
  }

  logEvento('multi_sede', 'warn', {
    operazione: 'admin/candidature-insegnanti:GET',
    esito: sedeAltrove ? 'curriculum-fuori-sede' : 'curriculum-non-risolto',
    azione: 'documento',
    utente: user.id,
    ruolo: user.role,
    sede_id: sedeAltrove,
    sedi_attive: scuole.length,
  })
  return docNegato()
}

/**
 * Il passaggio di stato, con la sede NELLA STESSA istruzione che scrive e gli
 * stati di partenza ammessi nel `WHERE`: è ciò che rende ATOMICO il claim
 * (`pending → in_approvazione`) e chiude la corsa fra due clic o due schede.
 * Zero righe non è un errore: è «qualcun altro è arrivato prima».
 */
async function cambiaStato(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  operazione: string,
  args: { id: string; scuole: string[]; da: string[]; patch: Record<string, unknown> },
): Promise<{
  righe: Record<string, unknown>[]
  error: { code?: string; message: string } | null
  /**
   * Le colonne TOLTE dalla scrittura perché il database non le ha. Va restituita,
   * e non solo loggata, perché senza di essa il chiamante non può distinguere
   * «scritto tutto» da «scritto in parte»: l'UPDATE ritorna comunque una riga —
   * `stato` c'è ancora — e ogni misura a valle direbbe «riuscito». È il modo in
   * cui l'audit tornava a dichiarare `utente_id: <uid>` su una riga che a
   * quell'account non era legata.
   */
  colonneCadute: string[]
}> {
  const record = { ...args.patch }
  const colonneCadute: string[] = []
  const scrivi = () =>
    supabase
      .from(TABELLA)
      .update(record)
      .eq('id', args.id)
      .in('stato', args.da)
      .in('scuola_id', args.scuole)
      .select(COLONNE_LAVORO)
  let esito = await scrivi()
  let tentativi = 0
  // Degrado sulla COLONNA assente (DB della CI non migrato). `stato` non si toglie
  // mai: senza quello l'istruzione non fa più ciò per cui esiste.
  while (esito.error && COLONNA_ASSENTE.has(codiceDi(esito.error) ?? '') && tentativi < 6) {
    const col = colonnaMancante(esito.error.message ?? '')
    if (!col || !(col in record) || col === 'stato') break
    logEvento('candidatura', 'warn', {
      operazione,
      esito: 'colonna-assente-rimossa',
      entita_tipo: TABELLA,
      error_code: codiceDi(esito.error),
      msg: `colonna assente, rimossa dalla scrittura: ${col}`,
    })
    delete record[col]
    colonneCadute.push(col)
    esito = await scrivi()
    tentativi++
  }
  return { righe: (esito.data ?? []) as Record<string, unknown>[], error: esito.error, colonneCadute }
}

/**
 * Rimette `pending` una candidatura CLAIMATA e non conclusa.
 *
 * Ogni uscita anticipata dell'approvazione passa di qui, e non è una cortesia:
 * una candidatura ferma in `in_approvazione` non è più approvabile da nessuno —
 * il claim pretende `pending` — e nessuno saprebbe perché. Il fallimento del
 * ripristino si logga a `error`: da lì in poi serve una mano umana.
 */
async function rimettiPending(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  args: { id: string; scuole: string[] },
): Promise<void> {
  const esito = await cambiaStato(supabase, 'admin/candidature-insegnanti:PATCH', {
    id: args.id,
    scuole: args.scuole,
    da: ['in_approvazione'],
    patch: { stato: 'pending', aggiornata_il: new Date().toISOString() },
  })
  if (esito.error || esito.righe.length === 0) {
    logEvento('candidatura', 'error', {
      operazione: 'admin/candidature-insegnanti:PATCH',
      esito: 'ripristino-pending-non-riuscito',
      entita_tipo: TABELLA,
      entita_id: args.id,
      error_code: codiceDi(esito.error),
    }, esito.error ?? undefined)
  }
}

/** APPROVA: claim atomico → account → credenziali → chiusura. In quest'ordine. */
async function approva(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: CandidaturaDiLavoro,
): Promise<NextResponse> {
  const operazione = 'admin/candidature-insegnanti:PATCH'
  const warnings: string[] = []
  const adesso = new Date().toISOString()

  // 1. CLAIM ATOMICO. Senza, due clic (o due schede) creano DUE account per la
  //    stessa persona: il secondo `createUser` fallirebbe sull'email, ma solo
  //    dopo aver marcato la candidatura una seconda volta — e con due password
  //    spedite. Zero righe ⇒ qualcuno è arrivato prima.
  const claim = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending'],
    patch: { stato: 'in_approvazione', aggiornata_il: adesso },
  })
  if (claim.error) {
    logEvento('candidatura', 'error', {
      operazione, esito: 'claim-non-riuscito', entita_tipo: TABELLA, entita_id: riga.id,
      error_code: codiceDi(claim.error),
    }, claim.error)
    return nonDisponibile('Non è stato possibile prendere in carico la candidatura: riprovare fra poco.')
  }
  if (claim.righe.length === 0) {
    logEvento('candidatura', 'warn', {
      operazione, esito: 'candidatura-gia-evasa', azione: 'approva',
      entita_tipo: TABELLA, entita_id: riga.id, stato: riga.stato,
    })
    return giaEvasa()
  }
  const presa = claim.righe[0] as unknown as CandidaturaDiLavoro
  const email = (presa.email ?? riga.email ?? '').trim()
  const sedeCandidatura = presa.scuola_id ?? riga.scuola_id

  if (!email) {
    await rimettiPending(supabase, { id: riga.id, scuole })
    logEvento('candidatura', 'error', {
      operazione, esito: 'candidatura-senza-email', entita_tipo: TABELLA, entita_id: riga.id,
    })
    return nonDisponibile('Questa candidatura non ha un indirizzo email: non è possibile creare l\'account.')
  }

  const gradi = gradiValidi(presa.gradi ?? riga.gradi)
  if (gradi.length === 0) {
    warnings.push(
      'La candidatura non porta nessuna fascia d\'età valida: assegnarle dal pannello Personale.',
    )
  }

  // 2. L'IDENTITÀ. Le due porte chiuse (email già staff, email già di un genitore)
  //    tornano un esito, non un'eccezione: qui si rimette `pending` e si risponde
  //    con il codice che dice alla segreteria cosa fare.
  const identita = await ensureStaffIdentity(supabase, {
    email,
    nome: (presa.nome ?? riga.nome ?? '').trim(),
    cognome: (presa.cognome ?? riga.cognome ?? '').trim(),
    cellulare: presa.telefono ?? riga.telefono ?? null,
    ruolo: 'educator',
    // LA SEDE È QUELLA DELLA CANDIDATURA, mai `user.scuola_id`: l'unico admin
    // reale ha Giugliano come sede primaria e gestisce tutti e tre i plessi.
    scuolaId: sedeCandidatura,
    gradi,
  })
  if (!identita.ok) {
    await rimettiPending(supabase, { id: riga.id, scuole })
    if (identita.reason === 'email_gia_staff') {
      return NextResponse.json(
        { error: identita.message, codice: CODICE_EMAIL_GIA_STAFF, ruoloEsistente: identita.ruoloEsistente ?? null },
        { status: 409 },
      )
    }
    if (identita.reason === 'email_gia_genitore') {
      return NextResponse.json(
        { error: identita.message, codice: CODICE_EMAIL_GIA_GENITORE },
        { status: 409 },
      )
    }
    // UN 503 CON QUALCOSA DI SCRITTO DIETRO va detto, non lasciato indovinare.
    // `accountOrfano` è vero solo quando l'account è nato in questa chiamata, la
    // riga `utenti` non è riuscita e nemmeno l'annullamento: la prossima
    // «Approva» riuserà quell'account e non produrrà nessuna password.
    if (identita.accountOrfano) {
      logEvento('candidatura', 'error', {
        operazione,
        esito: 'account-orfano-lasciato',
        entita_tipo: TABELLA,
        entita_id: riga.id,
        utente: identita.authUserIdOrfano ?? null,
        sede_id: sedeCandidatura,
      })
      return NextResponse.json(
        {
          error: identita.message,
          codice: CODICE_OPERAZIONE_NON_RIUSCITA,
          warnings: [
            'Un account di accesso È RIMASTO creato senza profilo: ripremere «Approva» NON genererà ' +
            'nessuna password. Le credenziali si ottengono solo con «Rigenera credenziali» dal ' +
            'pannello Personale — segnalarlo all\'assistenza.',
          ],
        },
        { status: 503 },
      )
    }
    logEvento('candidatura', 'error', {
      operazione, esito: 'account-non-creato', entita_tipo: TABELLA, entita_id: riga.id,
    })
    return nonDisponibile(identita.message)
  }
  if (!identita.gradiScritti && gradi.length > 0) {
    warnings.push(
      'Le fasce d\'età (gradi) non sono state registrate su questo ambiente: assegnarle dal pannello Personale.',
    )
  }
  if (!identita.createdAuth) {
    warnings.push(
      'Esisteva già un accesso con questa email: l\'account è stato riusato e NON è stata generata una nuova password.',
    )
  }

  // 3. LE CREDENZIALI. La sede nel testo è quella della candidatura: con tre
  //    plessi «Kidville» da solo non dice a nessuno dove è stata assunta.
  let credentialsEmailSent = false
  if (identita.createdAuth && identita.password) {
    const sedeNome = await nomeSede(supabase, sedeCandidatura, operazione)
    const invio = await sendEmailDetailed({
      to: email,
      subject: 'Le tue credenziali di accesso — Kidville',
      text: corpoCredenzialiStaff(presa.nome ?? riga.nome ?? null, email, identita.password, sedeNome),
    })
    credentialsEmailSent = invio.ok
    // L'esito dell'invio va nella risposta HTTP, nel log E a schermo: se l'email
    // non parte, l'account esiste comunque e l'operatore DEVE saperlo.
    //
    // ⚠️ DUE CANALI PER UN FATTO SOLO, e non è una distrazione. Il FALLIMENTO va
    // su `credenziali` a livello `error` — persistito PER LIVELLO, come già fa
    // `regenerate-credentials`. Il SUCCESSO va su `candidatura`, che è in
    // `EVENTI_PERSISTITI`: `credenziali` NON lo è, e un `logEvento('credenziali',
    // 'info', …)` vivrebbe qualche giorno sui Runtime Logs di Vercel e poi
    // sparirebbe — cioè il battito non sarebbe interrogabile in SQL proprio
    // quando serve («le credenziali di quella maestra sono partite davvero?»),
    // che è l'ambiguità con cui il guasto delle email è rimasto invisibile per
    // mesi. Il lock `__tests__/architecture/eventi-log.test.ts` lo impone, e ha
    // ragione. Il giorno in cui `credenziali` entrerà in `EVENTI_PERSISTITI`
    // (`src/lib/logging/logger.ts`) queste due righe tornano a essere una sola.
    if (invio.ok) {
      logEvento('candidatura', 'info', {
        operazione,
        esito: 'credenziali-inviate',
        canale: 'email',
        tipo: 'staff',
        entita_tipo: TABELLA,
        entita_id: riga.id,
        sede_id: sedeCandidatura,
      })
    } else {
      logEvento('credenziali', 'error', {
        operazione,
        esito: 'credenziali-non-inviate',
        canale: 'email',
        tipo: 'staff',
        entita_tipo: TABELLA,
        entita_id: riga.id,
        sede_id: sedeCandidatura,
      }, new Error(invio.error ?? 'motivo sconosciuto'))
      warnings.push(
        `Email delle credenziali NON inviata: ${invio.error ?? 'motivo sconosciuto'} — comunicarle a voce e poi rigenerarle dal pannello Personale.`,
      )
    }
  }

  // 4. LA CHIUSURA. Se fallisce QUI l'account esiste già: non si torna indietro e
  //    non si tace — si dice all'operatore di NON ripremere Approva.
  const chiusura = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['in_approvazione'],
    patch: {
      stato: 'approvata',
      evasa_il: adesso,
      evasa_da: user.id,
      utente_id: identita.authUserId,
      aggiornata_il: adesso,
    },
  })
  /**
   * L'UNICA VERITÀ SU COM'È FINITA, e da qui in giù la leggono tutti e tre i
   * canali — la risposta HTTP, l'audit e il battito.
   *
   * Prima esisteva solo dentro la `return`: l'audit e il battito la ignoravano e
   * dichiaravano «approvata» anche quando questo ramo aveva appena loggato
   * `approvazione-non-marcata` a `error`. Cioè la stessa bugia che la risposta
   * HTTP non racconta più, spostata nel registro IMMUTABILE delle scritture su
   * dati di minori e nel battito che il commento qui sotto dichiara essere
   * l'unico modo per distinguere «non si approva nessuno» da «l'approvazione non
   * parte più» — mentre lo falsava di uno a ogni guasto.
   */
  const chiusuraRiuscita = !chiusura.error && chiusura.righe.length > 0
  /**
   * …E LA CHIUSURA NON È UNA COSA SOLA. `chiusuraRiuscita` risponde a «la riga è
   * passata ad `approvata`?»; questo risponde a «la riga è LEGATA all'account?».
   * Sono due domande diverse dal giorno in cui il degrado su colonna assente può
   * togliere `utente_id` dal patch: l'istruzione passa lo stesso (solo `stato` è
   * protetto), l'UPDATE ritorna una riga, e una misura sola direbbe di sì a
   * entrambe le domande mentre la seconda risposta è no.
   *
   * Perché NON si è fatto il contrario — cioè `chiusuraRiuscita = false` quando
   * cade una colonna: sarebbe stata la bugia speculare. Lo stato in tabella È
   * `approvata`, e un audit che dicesse `in_approvazione` mentirebbe su ciò che
   * si legge nella riga. E perché non si è protetto `utente_id` come `stato`:
   * quel ramo lascerebbe la candidatura ferma in `in_approvazione` — non più
   * approvabile da nessuno, il claim pretende `pending` — con l'account già
   * creato e le credenziali già partite. Si scrive ciò che si può, e si DICE
   * che cosa non si è scritto: è la stessa scelta già presa per `gradi`.
   */
  const utenteIdScritto = chiusuraRiuscita && !chiusura.colonneCadute.includes('utente_id')
  if (chiusura.colonneCadute.length > 0) {
    warnings.push(
      `Chiusura registrata solo in parte: su questo ambiente mancano le colonne ${chiusura.colonneCadute.join(', ')}.` +
        (utenteIdScritto
          ? ''
          : ' La candidatura NON risulta legata all\'account creato: NON ripremere «Approva» — segnalarlo all\'assistenza.'),
    )
  }
  if (!chiusuraRiuscita) {
    logEvento('candidatura', 'error', {
      operazione,
      esito: 'approvazione-non-marcata',
      entita_tipo: TABELLA,
      entita_id: riga.id,
      utente: identita.authUserId,
      error_code: codiceDi(chiusura.error),
    }, chiusura.error ?? undefined)
    warnings.push(
      'L\'account È STATO CREATO ma la candidatura non risulta marcata come approvata: NON ripremere «Approva» — segnalarlo all\'assistenza.',
    )
  }

  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'candidatura',
    entitaId: riga.id,
    azione: 'update',
    scuolaId: sedeCandidatura,
    // L'audit dice CHE COSA è stato fatto, non è una copia della candidatura:
    // niente email, niente nome, niente curriculum.
    //
    // `stato` è quello VERO in tabella, e `utente_id` è quello VERO NELLA RIGA:
    // `null` quando il legame non è stato scritto — chiusura fallita, oppure
    // colonna assente su questo database. Prima portava sempre l'uid, e chi a
    // mesi di distanza leggesse `valore_dopo->>'utente_id'` per sapere a quale
    // account è legata quella candidatura avrebbe trovato un uid che nella riga
    // non c'è mai stato: un registro immutabile che risponde una cosa falsa.
    //
    // L'uid però NON si perde, ed è la ragione della chiave separata: l'account
    // ESISTE (le credenziali sono partite) e questo è l'unico registro DUREVOLE
    // in cui ritrovarlo — `app_log` si cancella a 30 giorni. `account_uid` dice
    // «l'account è questo», senza spacciarlo per una colonna della candidatura.
    valoreDopo: {
      stato: chiusuraRiuscita ? 'approvata' : 'in_approvazione',
      chiusura_riuscita: chiusuraRiuscita,
      utente_id: utenteIdScritto ? identita.authUserId : null,
      account_uid: identita.authUserId,
      account_creato: identita.createdAuth,
    },
  })

  // Evento critico → si logga anche il SUCCESSO: senza, «nessun log» non
  // distinguerebbe «non si approva nessuno» da «l'approvazione non parte più».
  //
  // Due esiti DIVERSI, e non un campo in più su uno solo: `candidatura-approvata`
  // è il conteggio delle approvazioni VERE («quante insegnanti sono state
  // assunte questo mese?»), e una riga emessa su una chiusura fallita lo
  // gonfierebbe proprio quando il sistema sta sbagliando. Il gesto si chiude
  // comunque a registro, ma con il suo nome e a `warn`.
  const battito = {
    operazione,
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: sedeCandidatura,
    utente: identita.authUserId,
    account_creato: identita.createdAuth,
    gradi_scritti: identita.gradiScritti,
    email_inviata: credentialsEmailSent,
    chiusura_riuscita: chiusuraRiuscita,
    // Le due domande restano due anche nel battito: «lo stato è passato?» e «la
    // riga è legata all'account?». Un `chiusura_riuscita: true` da solo non
    // distingue una chiusura intera da una a cui manca il legame.
    utente_id_scritto: utenteIdScritto,
  }
  if (chiusuraRiuscita) {
    logEvento('candidatura', 'info', { ...battito, esito: 'candidatura-approvata' })
  } else {
    logEvento('candidatura', 'warn', { ...battito, esito: 'candidatura-approvata-non-marcata' })
  }

  return NextResponse.json({
    success: true,
    id: riga.id,
    stato: chiusuraRiuscita ? 'approvata' : 'in_approvazione',
    // La password si vede UNA volta sola, qui. Non viene archiviata da nessuna
    // parte: per riaverla c'è «Rigenera credenziali», che la sostituisce e lascia
    // traccia.
    credentials: identita.createdAuth && identita.password ? { email, password: identita.password } : null,
    credentialsEmailSent,
    warnings,
  })
}

/** RIFIUTA: nessun account, nessuna riga `utenti`, e il motivo resta una nota interna. */
async function rifiuta(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  user: AppUser,
  scuole: string[],
  riga: CandidaturaDiLavoro,
  motivo: string | null,
  inviaEmailEsito: boolean,
): Promise<NextResponse> {
  const operazione = 'admin/candidature-insegnanti:PATCH'
  const warnings: string[] = []
  const adesso = new Date().toISOString()

  // Si rifiuta ciò che è ancora in gioco: `pending` oppure `in_approvazione`
  // (una presa in carico rimasta appesa). Zero righe ⇒ ha già deciso qualcun altro.
  const esito = await cambiaStato(supabase, operazione, {
    id: riga.id,
    scuole,
    da: ['pending', 'in_approvazione'],
    patch: {
      stato: 'rifiutata',
      evasa_il: adesso,
      evasa_da: user.id,
      motivo_rifiuto: motivo,
      aggiornata_il: adesso,
    },
  })
  if (esito.error) {
    logEvento('candidatura', 'error', {
      operazione, esito: 'rifiuto-non-registrato', entita_tipo: TABELLA, entita_id: riga.id,
      error_code: codiceDi(esito.error),
    }, esito.error)
    return nonDisponibile('Non è stato possibile registrare il rifiuto: riprovare fra poco.')
  }
  if (esito.righe.length === 0) {
    logEvento('candidatura', 'warn', {
      operazione, esito: 'candidatura-gia-evasa', azione: 'rifiuta',
      entita_tipo: TABELLA, entita_id: riga.id, stato: riga.stato,
    })
    return giaEvasa()
  }
  if (esito.colonneCadute.length > 0) {
    warnings.push(
      `Rifiuto registrato solo in parte: su questo ambiente mancano le colonne ${esito.colonneCadute.join(', ')}.`,
    )
  }

  await logScrittura(supabase, {
    attore: user,
    entitaTipo: 'candidatura',
    entitaId: riga.id,
    azione: 'update',
    scuolaId: riga.scuola_id,
    // Il TESTO del motivo non entra nell'audit: è una nota interna su una persona,
    // e l'audit deve dire che cosa è successo, non conservarne il giudizio.
    //
    // `motivo_presente` parla della RIGA, non dell'intenzione di chi ha premuto:
    // se `motivo_rifiuto` è caduta dal degrado su colonna assente, la nota non è
    // stata scritta da nessuna parte e dichiararla presente manderebbe qualcuno,
    // fra mesi, a cercare in tabella un testo che non c'è.
    valoreDopo: {
      stato: 'rifiutata',
      motivo_presente: Boolean(motivo) && !esito.colonneCadute.includes('motivo_rifiuto'),
    },
  })

  // Email di cortesia: SOLO se l'operatore l'ha chiesta, e senza motivazione —
  // quello che si scrive in segreteria non è quello che si dice alla persona.
  let esitoEmailInviato = false
  const email = (riga.email ?? '').trim()
  if (inviaEmailEsito && email) {
    const sedeNome = await nomeSede(supabase, riga.scuola_id, operazione)
    const invio = await sendEmailDetailed({
      to: email,
      subject: 'Esito della tua candidatura — Kidville',
      text: corpoEsitoNegativo(riga.nome, sedeNome),
    })
    esitoEmailInviato = invio.ok
    logEvento('candidatura', invio.ok ? 'info' : 'warn', {
      operazione,
      esito: invio.ok ? 'esito-inviato' : 'esito-non-inviato',
      canale: 'email',
      entita_tipo: TABELLA,
      entita_id: riga.id,
      sede_id: riga.scuola_id,
    }, invio.ok ? undefined : new Error(invio.error ?? 'motivo sconosciuto'))
    if (!invio.ok) {
      warnings.push(`Email di esito NON inviata: ${invio.error ?? 'motivo sconosciuto'}.`)
    }
  }

  logEvento('candidatura', 'info', {
    operazione,
    esito: 'candidatura-rifiutata',
    entita_tipo: TABELLA,
    entita_id: riga.id,
    sede_id: riga.scuola_id,
    motivo_presente: Boolean(motivo),
    email_inviata: esitoEmailInviato,
  })

  return NextResponse.json({
    success: true,
    id: riga.id,
    stato: 'rifiutata',
    esitoEmailInviato,
    warnings,
  })
}

/**
 * Il testo delle CREDENZIALI di un membro dello STAFF.
 *
 * Scritto qui e non riusando `credentialsEmailBody` (`src/lib/email/send.ts`),
 * che è il corpo del GENITORE: saluta «Gentile genitore,», dice «la tua
 * iscrizione a <sede> è stata registrata» e manda «all'area genitori». Sarebbe
 * partito, con dentro la password temporanea, verso una persona vera che si è
 * candidata per LAVORARE — e alla prima approvazione, non un giorno lontano.
 *
 * Le differenze non sono di cortesia: il saluto di ripiego è neutro (una
 * candidatura non ha un genere dichiarato), il fatto raccontato è l'assunzione e
 * non un'iscrizione, e la destinazione è l'area riservata al personale.
 */
function corpoCredenzialiStaff(
  nome: string | null,
  email: string,
  password: string,
  sedeNome: string | null,
): string {
  const saluto = nome && nome.trim() !== '' ? `Gentile ${nome.trim()},` : 'Gentile collega,'
  const sede = (sedeNome ?? '').trim()
  const loginUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/auth/login`
    : 'la pagina di accesso'
  return [
    saluto,
    '',
    `la sua candidatura a ${sede || 'Kidville'} è stata accolta: le abbiamo aperto l'accesso all'area riservata al personale.`,
    '',
    `  Email: ${email}`,
    `  Password temporanea: ${password}`,
    '',
    `Acceda da ${loginUrl} e, per sicurezza, cambi la password al primo accesso.`,
    '',
    'A presto,',
    sede ? `Lo staff di ${sede}` : 'Lo staff Kidville',
  ].join('\n')
}

/** Il testo dell'esito negativo: neutro, senza motivazioni e senza credenziali. */
function corpoEsitoNegativo(nome: string | null, sedeNome: string | null): string {
  const saluto = nome && nome.trim() !== '' ? `Gentile ${nome.trim()},` : 'Gentile candidata, gentile candidato,'
  const sede = (sedeNome ?? '').trim()
  return [
    saluto,
    '',
    `la ringraziamo per la candidatura inviata a ${sede || 'Kidville'} e per il tempo che ci ha dedicato.`,
    'Dopo averla esaminata, al momento non possiamo darle seguito.',
    '',
    'Se ci ha autorizzati a conservare i suoi dati, la ricontatteremo quando si aprirà una posizione adatta al suo profilo.',
    '',
    'Un cordiale saluto,',
    sede ? `Lo staff di ${sede}` : 'Lo staff Kidville',
  ].join('\n')
}
