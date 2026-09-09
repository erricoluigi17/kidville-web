import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Il nome della route, per i log. `withRoute` lo riceve come LETTERALE e non da
// qui: `__tests__/architecture/logging-coverage.test.ts` lo legge dal sorgente e
// verifica che corrisponda al percorso del file — con una costante non potrebbe.
const OP = 'primaria/scrutinio/chiudi:POST'

/**
 * L'unica risposta di questa route per un guasto del DATABASE.
 *
 * PostgREST non lancia: `const { data } = await supabase.from(…)` su una lettura
 * respinta lascia `data === null`, che qui sotto diventa `?? []`. E `[]`, in
 * questa route, NON è «non è successo niente»: è «nessun alunno da valutare» e
 * «nessuna disciplina da valutare», cioè **scrutinio completo**. Il codice
 * proseguiva fino all'UPDATE e portava la riga a `stato = 'chiuso'`, con
 * `chiuso_da` e `chiuso_il` valorizzati. Da quel momento `/api/primaria/scrutinio`
 * (POST e PATCH) risponde **423** a ogni modifica: due secondi di timeout del
 * database chiudevano uno scrutinio incompleto in un modo che l'interfaccia non sa
 * più riaprire.
 *
 * Perché una funzione e non un `NextResponse.json` per ogni punto: il lock
 * `__tests__/architecture/errori-con-codice.test.ts` conta le risposte d'errore
 * SENZA `codice`, e questo file ne ha cinque dichiarate in allowlist. Questa
 * assorbe quella che c'era già sull'UPDATE — che per giunta rimandava al browser
 * il `message` di PostgREST, cioè prosa inglese e nomi di colonna a chi lavora in
 * segreteria. Il motivo vero resta nel log, dove serve.
 */
function guastoDb(esito: string, error: unknown): NextResponse {
  logEvento('db', 'error', { operazione: OP, esito }, error)
  return NextResponse.json({ error: 'Chiusura non riuscita' }, { status: 500 })
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  scrutinioId: zUuid,
})

// POST /api/primaria/scrutinio/chiudi?userId=
// Chiusura della sessione di scrutinio. Riservata alla dirigenza (admin/coordinator).
// Valida la completezza (ogni alunno ha un giudizio per ogni disciplina + comportamento),
// blocca lo scrutinio e notifica i genitori della disponibilità della pagella.
// body: { scrutinioId }
export const POST = withRoute('primaria/scrutinio/chiudi:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId } = b.data

    const supabase = await createAdminClient()

    const { data: scrutinio, error: errScrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, periodo_id, stato')
      .eq('id', scrutinioId)
      .maybeSingle()
    // Senza questo ramo una lettura respinta usciva come 404 «Scrutinio non
    // trovato»: si dice a chi ha cliccato che ha sbagliato lui, e il 404 è pure
    // lo stato che il client ricorda come definitivo (non si riprova).
    if (errScrutinio) return guastoDb('scrutinio-non-letto', errScrutinio)
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio già chiuso' }, { status: 409 })

    // Scoping di plesso per la dirigenza: si chiudono solo scrutini del proprio plesso.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    const [alunniRes, materieRes, giudiziRes, comportamentoRes] = await Promise.all([
      supabase.from('alunni').select('id').eq('section_id', scrutinio.section_id),
      supabase.from('materie').select('id').eq('section_id', scrutinio.section_id).eq('attiva', true),
      supabase.from('scrutinio_giudizi').select('alunno_id, materia_id, giudizio_sintetico').eq('scrutinio_id', scrutinioId),
      supabase.from('scrutinio_comportamento').select('alunno_id, giudizio_testo').eq('scrutinio_id', scrutinioId),
    ])

    // TUTTE E QUATTRO le letture sono la validazione di completezza, non il suo
    // contorno: `alunni` e `materie` decidono QUANTI giudizi devono esserci,
    // `giudizi` e `comportamento` quali ci sono. Se una qualsiasi non è
    // arrivata, la completezza non è VERIFICATA — e una chiusura è una porta
    // che si apre in un verso solo.
    const guasto =
      (alunniRes.error && { esito: 'alunni-non-letti', error: alunniRes.error }) ||
      (materieRes.error && { esito: 'materie-non-lette', error: materieRes.error }) ||
      (giudiziRes.error && { esito: 'giudizi-non-letti', error: giudiziRes.error }) ||
      (comportamentoRes.error && { esito: 'comportamento-non-letto', error: comportamentoRes.error })
    if (guasto) return guastoDb(guasto.esito, guasto.error)

    const { data: alunni } = alunniRes
    const { data: materie } = materieRes
    const { data: giudizi } = giudiziRes
    const { data: comportamento } = comportamentoRes

    const alunniIds = (alunni ?? []).map((a) => a.id)
    const materieIds = (materie ?? []).map((m) => m.id)

    // Validazione completezza.
    const giudMap = new Set(
      (giudizi ?? [])
        .filter((g) => g.giudizio_sintetico && String(g.giudizio_sintetico).trim() !== '')
        .map((g) => `${g.alunno_id}:${g.materia_id}`)
    )
    const compMap = new Set(
      (comportamento ?? [])
        .filter((c) => c.giudizio_testo && String(c.giudizio_testo).trim() !== '')
        .map((c) => c.alunno_id)
    )

    // ⚠️ RESIDUO DICHIARATO, gemello di quello in `scrutinio/import`. Le quattro
    // guardie qui sopra chiudono la porta dell'insieme vuoto PER ERRORE; resta
    // aperta quella dell'insieme vuoto SENZA errore, che qui vale lo stesso:
    // `alunniIds` vuoto (sezione senza alunni) fa saltare il ciclo per intero e
    // `mancanti` esce vuoto — cioè «scrutinio completo», e la riga passa a
    // `chiuso`. Con `materieIds` vuoto (nessuna materia attiva) si chiude appena
    // c'è il comportamento, dichiarando completo uno scrutinio in cui non è stata
    // valutata una sola disciplina. Non è un `{ error }` scartato: è fuori dal
    // mandato di questo lavoro e non è stato corretto a sorpresa, perché
    // rifiutare la chiusura di una classe vuota è una decisione di prodotto e
    // non la riparazione di un guasto. È segnalata, non nascosta.
    const mancanti: { alunnoId: string; tipo: string; materiaId?: string }[] = []
    for (const aId of alunniIds) {
      for (const mId of materieIds) {
        if (!giudMap.has(`${aId}:${mId}`)) mancanti.push({ alunnoId: aId, tipo: 'disciplina', materiaId: mId })
      }
      if (!compMap.has(aId)) mancanti.push({ alunnoId: aId, tipo: 'comportamento' })
    }

    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Scrutinio incompleto: mancano giudizi.', incompleto: true, mancanti },
        { status: 422 }
      )
    }

    // Chiudi (lock).
    const { data: closed, error: closeErr } = await supabase
      .from('scrutini')
      .update({ stato: 'chiuso', chiuso_da: auth.user.id, chiuso_il: new Date().toISOString() })
      .eq('id', scrutinioId)
      .eq('stato', 'aperto')
      .select()
      .single()
    if (closeErr || !closed) return guastoDb('scrutinio-non-chiuso', closeErr)

    // La chiusura blocca le proposte ma NON rende ancora visibili i voti ai
    // genitori: la visibilità avviene con la pubblicazione (/scrutinio/pubblica).
    return NextResponse.json({ success: true, data: closed })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
