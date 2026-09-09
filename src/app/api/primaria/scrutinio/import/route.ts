import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Il nome della route, per i log. `withRoute` lo riceve come LETTERALE e non da
// qui: `__tests__/architecture/logging-coverage.test.ts` lo legge dal sorgente e
// verifica che corrisponda al percorso del file — con una costante non potrebbe.
const OP = 'primaria/scrutinio/import:POST'

/**
 * L'unica risposta di questa route per un guasto del DATABASE.
 *
 * PostgREST non lancia, e qui gli `{ error }` scartati non producevano un import
 * vuoto: producevano un import DIVERSO.
 *
 *  - `giudizi_sintetici_scala` (o la `sections` da cui si ricava lo `scuola_id`)
 *    non letta lascia `scalaSet` vuoto, e il controllo più in basso è scritto
 *    `if (scalaSet.size > 0 && …)`: a scala vuota **non si valida più niente**.
 *    Un CSV entrava in `scrutinio_giudizi` con etichette che la scuola non ha mai
 *    configurato — su un documento di valutazione, e senza una riga di errore.
 *  - `alunni`/`materie` non lette rendono vuote le mappe di risoluzione, e ogni
 *    riga del file esce come «Alunno non trovato: …» / «Materia non trovata: …»:
 *    un 200 che dà la colpa al file caricato dall'insegnante per un guasto nostro.
 *
 * Una funzione sola perché il lock `__tests__/architecture/errori-con-codice.test.ts`
 * conta le risposte d'errore senza `codice` (qui quattro, da allowlist): questa
 * assorbe quella che c'era già sull'upsert — che rimandava al browser il `message`
 * di PostgREST. Il motivo vero resta nel log.
 */
function guastoDb(esito: string, error: unknown): NextResponse {
  logEvento('db', 'error', { operazione: OP, esito }, error)
  return NextResponse.json({ error: 'Import non riuscito' }, { status: 500 })
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// righe[] resta volutamente permissivo (z.unknown()): l'handler risolve e
// valida ogni riga singolarmente (per id o per nome/codice) accumulando gli
// errori riga per riga in `errori`, senza rifiutare l'intera richiesta.
const postBodySchema = z.object({
  scrutinioId: zUuid,
  righe: z.array(z.unknown()),
})

// POST /api/primaria/scrutinio/import?userId=
// Caricamento massivo dei giudizi sintetici di uno scrutinio (aperto) via CSV.
// Le righe parse-ate lato client possono identificare alunno e materia per id
// oppure per nome/cognome / nome materia. Valida i giudizi contro la scala.
// body: { scrutinioId, righe: [{ alunnoId?, alunno?, materiaId?, materia?, giudizioSintetico }] }
export const POST = withRoute('primaria/scrutinio/import:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId, righe } = b.data

    const supabase = await createAdminClient()

    const { data: scrutinio, error: errScrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato')
      .eq('id', scrutinioId)
      .maybeSingle()
    // Una lettura respinta usciva come 404 «Scrutinio non trovato», cioè lo stato
    // che dice a chi ha caricato il file che ha sbagliato indirizzo.
    if (errScrutinio) return guastoDb('scrutinio-non-letto', errScrutinio)
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: import non consentito', locked: true }, { status: 423 })

    // Scope sulla sezione dello scrutinio (educator: solo proprie sezioni; staff: plesso).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    // Anagrafiche della sezione per risoluzione per nome.
    const [alunniRes, materieRes, sezRes] = await Promise.all([
      supabase.from('alunni').select('id, nome, cognome').eq('section_id', scrutinio.section_id),
      supabase.from('materie').select('id, nome, codice').eq('section_id', scrutinio.section_id),
      supabase.from('sections').select('scuola_id').eq('id', scrutinio.section_id).maybeSingle(),
    ])
    const guasto =
      (alunniRes.error && { esito: 'alunni-non-letti', error: alunniRes.error }) ||
      (materieRes.error && { esito: 'materie-non-lette', error: materieRes.error }) ||
      (sezRes.error && { esito: 'sezione-non-letta', error: sezRes.error })
    if (guasto) return guastoDb(guasto.esito, guasto.error)
    const { data: alunni } = alunniRes
    const { data: materie } = materieRes
    const { data: sez } = sezRes

    // Scala valida (etichette consentite).
    // ⚠️ RESIDUO DICHIARATO: se `sez` è `null` SENZA errore (sezione sparita fra la
    // lettura dello scrutinio e questa) `scalaSet` resta vuoto e il controllo più
    // in basso si spegne lo stesso. Non è un `{ error }` scartato e non è stato
    // toccato qui: è la stessa porta con un'altra maniglia, ed è segnalata.
    let scalaSet = new Set<string>()
    if (sez?.scuola_id) {
      const { data: scala, error: errScala } = await supabase.from('giudizi_sintetici_scala').select('etichetta').eq('scuola_id', sez.scuola_id)
      // La scala non letta NON è «scuola senza scala configurata»: è la
      // validazione che non si è potuta fare. Proseguire vorrebbe dire accettare
      // qualunque etichetta.
      if (errScala) return guastoDb('scala-non-letta', errScala)
      scalaSet = new Set((scala ?? []).map((s) => s.etichetta.toLowerCase()))
    }

    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
    const alunnoById = new Map((alunni ?? []).map((a) => [a.id, a]))
    const alunnoByNome = new Map((alunni ?? []).map((a) => [norm(`${a.cognome} ${a.nome}`), a.id]))
    const materiaById = new Map((materie ?? []).map((m) => [m.id, m]))
    const materiaByNome = new Map((materie ?? []).map((m) => [norm(m.nome), m.id]))
    const materiaByCodice = new Map((materie ?? []).map((m) => [norm(m.codice), m.id]))

    const errori: { riga: number; messaggio: string }[] = []
    const rows: Record<string, unknown>[] = []

    righe.forEach((raw, i) => {
      const r = raw as Record<string, unknown>
      const n = i + 1
      const alunnoId = r.alunnoId && alunnoById.has(String(r.alunnoId))
        ? String(r.alunnoId)
        : alunnoByNome.get(norm(r.alunno))
      if (!alunnoId) { errori.push({ riga: n, messaggio: `Alunno non trovato: ${r.alunno ?? r.alunnoId ?? ''}` }); return }

      const materiaId = r.materiaId && materiaById.has(String(r.materiaId))
        ? String(r.materiaId)
        : materiaByNome.get(norm(r.materia)) ?? materiaByCodice.get(norm(r.materia))
      if (!materiaId) { errori.push({ riga: n, messaggio: `Materia non trovata: ${r.materia ?? r.materiaId ?? ''}` }); return }

      const giudizio = String(r.giudizioSintetico ?? '').trim()
      if (!giudizio) { errori.push({ riga: n, messaggio: 'Giudizio mancante' }); return }
      if (scalaSet.size > 0 && !scalaSet.has(giudizio.toLowerCase())) {
        errori.push({ riga: n, messaggio: `Giudizio non in scala: ${giudizio}` }); return
      }

      rows.push({
        scrutinio_id: scrutinioId,
        alunno_id: alunnoId,
        materia_id: materiaId,
        giudizio_sintetico: giudizio,
        proposto_da: userId,
      })
    })

    let importate = 0
    if (rows.length > 0) {
      const { data, error } = await supabase
        .from('scrutinio_giudizi')
        .upsert(rows, { onConflict: 'scrutinio_id,alunno_id,materia_id' })
        .select('id')
      if (error) return guastoDb('giudizi-non-scritti', error)
      importate = (data ?? []).length
    }

    return NextResponse.json({ success: true, importate, errori })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
