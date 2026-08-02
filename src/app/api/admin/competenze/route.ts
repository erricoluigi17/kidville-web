import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { seedCertificato } from '@/lib/competenze/certificato-store'
import { COMPETENZE_SIGNIFICATIVE_CODICE } from '@/lib/competenze/modello'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Sede dell'OGGETTO, non dell'operatore ───────────────────────────────────
// L'audit di questa route registrava `auth.user.scuola_id`: per l'unico admin
// reale è sempre Giugliano, quindi la generazione di un certificato per una
// classe di Cesa restava a registro come operazione di Giugliano. Un registro
// delle scritture che attribuisce l'evento alla sede sbagliata è peggio di un
// registro assente: dice il falso proprio quando lo si va a leggere. La sede si
// prende dalla SEZIONE, già validata da `assertSezioneInScope` (stesso schema di
// `admin/protocolli/genera-documento:73-77`).
async function sedeDellaSezione(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sectionId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('sections')
    .select('scuola_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (error) {
    // PostgREST non lancia: senza il controllo l'audit tornerebbe in silenzio
    // alla sede dell'operatore, cioè al difetto che si sta correggendo.
    logEvento('db', 'error', { operazione: 'admin/competenze', esito: 'sede-sezione-non-letta' }, error)
    return null
  }
  return (data?.scuola_id as string | null) ?? null
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id restano stringhe libere (niente zUuid): oggi il codice non impone
// alcun formato e nei test/dati seed circolano id non-UUID.
// `userId` in query è consumato dal gate (requireStaff), non qui.

const getQuerySchema = z.object({
  sectionId: z.string({ error: 'sectionId obbligatorio' }).min(1, 'sectionId obbligatorio'),
})

const postBodySchema = z.object({
  sectionId: z.string({ error: 'sectionId obbligatorio' }).min(1, 'sectionId obbligatorio'),
  // opzionale: la guardia truthy resta nell'handler (stringa vuota/null → intera classe, come oggi)
  alunnoId: z.string().nullish(),
})

const patchBodySchema = z.object({
  certificatoId: z.string({ error: 'certificatoId obbligatorio' }).min(1, 'certificatoId obbligatorio'),
  livelli: z
    .array(
      z.object({
        competenza_codice: z.string(),
        livello: z.string().nullish(),
        note: z.string().nullish(),
      })
    )
    .nullish(),
  // presente (anche null) → aggiorna la nota "competenze significative"
  competenzeSignificative: z.string().nullish(),
})

// GET /api/admin/competenze?sectionId=&userId=  — elenco certificati della sezione.
export const GET = withRoute('admin/competenze:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    // Isolamento per sede: `sectionId` arrivava dal client senza verifica — si
    // leggevano e si scrivevano materie, orari, obiettivi e certificati delle
    // competenze su sezioni di un'altra sede.
    const fuoriScopeSez = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (fuoriScopeSez) return fuoriScopeSez

    const { data: certs } = await supabase
      .from('certificati_competenze')
      .select('id, alunno_id, anno_scolastico, stato, generato_il, alunni(nome, cognome), certificato_competenza_livelli(competenza_codice, livello, note, ordine)')
      .eq('section_id', sectionId)
      .order('created_at', { ascending: false })
    return NextResponse.json({ success: true, data: certs ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/competenze:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/competenze?userId=  — crea/riallinea le bozze (1 alunno o intera classe).
// body: { sectionId, alunnoId? }. Guard livello-5/scrutinio-chiuso da seedCertificato.
export const POST = withRoute('admin/competenze:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()

    // Isolamento per sede: si generavano certificati delle competenze per una
    // sezione di un'altra sede passandone l'uuid.
    const fuoriScopePost = await assertSezioneInScope(supabase, auth.user, body.sectionId)
    if (fuoriScopePost) return fuoriScopePost
    const scuolaSezione = await sedeDellaSezione(supabase, body.sectionId)

    let alunniIds: string[] = []
    if (body.alunnoId) alunniIds = [body.alunnoId]
    else {
      const { data: alunni } = await supabase.from('alunni').select('id').eq('section_id', body.sectionId)
      alunniIds = ((alunni ?? []) as { id: string }[]).map((a) => a.id)
    }

    let creati = 0
    const errori: { alunnoId: string; error?: string; status?: number }[] = []
    let firstErrStatus: number | undefined
    for (const alunnoId of alunniIds) {
      const r = await seedCertificato(supabase, body.sectionId, alunnoId)
      if (r.error) {
        errori.push({ alunnoId, error: r.error, status: r.status })
        firstErrStatus = firstErrStatus ?? r.status
      } else {
        creati++
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'certificato_competenze',
          entitaId: r.certificatoId,
          azione: 'insert',
          scuolaId: scuolaSezione,
          sectionId: body.sectionId,
        })
      }
    }
    // Se nessun certificato è stato creato e c'è un errore di guard, propaga lo status.
    if (creati === 0 && firstErrStatus) return NextResponse.json({ error: errori[0].error, errori }, { status: firstErrStatus })
    return NextResponse.json({ success: true, creati, totale: alunniIds.length, errori })
  } catch (err) {
    logErrore({ operazione: 'admin/competenze:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/admin/competenze?userId=  — modifica livelli + competenze significative.
// body: { certificatoId, livelli: [{competenza_codice, livello, note?}], competenzeSignificative? }
export const PATCH = withRoute('admin/competenze:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()

    // Isolamento per sede: la PATCH riceve solo `certificatoId` e riscriveva i
    // livelli (e riportava in bozza, invalidando la firma) di QUALUNQUE
    // certificato delle tre sedi. La sezione è la fonte di verità della sede
    // anche qui: si risolve dal certificato e poi si passa dallo stesso gate
    // delle altre due letture.
    const { data: cert, error: errCert } = await supabase
      .from('certificati_competenze')
      .select('id, section_id')
      .eq('id', body.certificatoId)
      .maybeSingle()
    if (errCert) {
      logEvento('db', 'error', { operazione: 'admin/competenze:PATCH', esito: 'certificato-non-letto' }, errCert)
      return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
    }
    if (!cert) return NextResponse.json({ error: 'Certificato non trovato' }, { status: 404 })
    const sectionId = cert.section_id as string
    const fuoriScopePatch = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (fuoriScopePatch) return fuoriScopePatch
    const scuolaSezione = await sedeDellaSezione(supabase, sectionId)

    const rows: { certificato_id: string; competenza_codice: string; livello: string | null; note: string | null }[] = []
    for (const l of body.livelli ?? []) {
      rows.push({ certificato_id: body.certificatoId, competenza_codice: l.competenza_codice, livello: l.livello ?? null, note: l.note ?? null })
    }
    if (body.competenzeSignificative !== undefined) {
      rows.push({ certificato_id: body.certificatoId, competenza_codice: COMPETENZE_SIGNIFICATIVE_CODICE, livello: null, note: body.competenzeSignificative ?? null })
    }
    if (rows.length) {
      // PostgREST non lancia: senza il controllo, livelli non salvati e
      // «salvato» a schermo erano indistinguibili.
      const { error: errLivelli } = await supabase
        .from('certificato_competenza_livelli')
        .upsert(rows, { onConflict: 'certificato_id,competenza_codice' })
      if (errLivelli) {
        logEvento('db', 'error', { operazione: 'admin/competenze:PATCH', esito: 'livelli-non-salvati' }, errLivelli)
        return NextResponse.json({ error: 'Salvataggio dei livelli non riuscito' }, { status: 500 })
      }
    }
    // Una modifica invalida la firma precedente: torna in bozza.
    const { error: errStato } = await supabase
      .from('certificati_competenze')
      .update({ stato: 'bozza', updated_at: new Date().toISOString() })
      .eq('id', body.certificatoId)
    if (errStato) {
      // Peggiore del precedente: il certificato resterebbe «firmato» con dentro
      // livelli nuovi, cioè una firma che non copre più il contenuto.
      logEvento('db', 'error', { operazione: 'admin/competenze:PATCH', esito: 'stato-non-riportato-in-bozza' }, errStato)
      return NextResponse.json({ error: 'Aggiornamento del certificato non riuscito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'certificato_competenze',
      entitaId: body.certificatoId,
      azione: 'update',
      scuolaId: scuolaSezione,
      sectionId,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'admin/competenze:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
