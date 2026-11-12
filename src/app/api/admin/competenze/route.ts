import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope, resolveAnnoScrittura, assertSezioneScrivibile } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { annoDaEtichetta } from '@/lib/anno/etichetta'
import { erroreAnno } from '@/lib/anno/errori'
import { zCorrezione } from '@/lib/anno/correzione'
import { seedCertificato, validaScrutinioFinaleClasseQuinta } from '@/lib/competenze/certificato-store'
import { COMPETENZE_SIGNIFICATIVE_CODICE } from '@/lib/competenze/modello'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/db/guasto'

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
  // Su un anno chiuso la segreteria registra una CORREZIONE (PR 4.9): il motivo sta nella riga del gettone, mai in un log.
  correzione: zCorrezione.optional(),
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

    const { data: certs, error: errCerts } = await supabase
      .from('certificati_competenze')
      .select('id, alunno_id, anno_scolastico, stato, generato_il, alunni(nome, cognome), certificato_competenza_livelli(competenza_codice, livello, note, ordine)')
      .eq('section_id', sectionId)
      .order('created_at', { ascending: false })
    // Un guasto non è «nessun certificato».
    if (errCerts) return rispostaGuastoDb('admin/competenze:GET', 'db:certificati_competenze', errCerts)
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
    const fuoriScopePost = await assertSezioneScrivibile(supabase, auth.user, body.sectionId)
    if (fuoriScopePost) return fuoriScopePost
    const scuolaSezione = await sedeDellaSezione(supabase, body.sectionId)
    // Senza la sede non c'è anno da dichiarare: scrivere un certificato così lo lascerebbe senza `anno_id`. È un
    // guasto di lettura (la sezione è già in scope), già registrato a `error` da `sedeDellaSezione`: nessun secondo log.
    if (!scuolaSezione) {
      return NextResponse.json({ error: 'Impossibile leggere la sede della classe: nessun certificato creato. Riprova.', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }

    let alunniIds: string[] = []
    if (body.alunnoId) alunniIds = [body.alunnoId]
    else {
      // Un guasto qui darebbe «0 creati su 0» con esito positivo: la classe resterebbe senza bozze.
      const { data: alunni, error: errAlunni } = await supabase.from('alunni').select('id').eq('section_id', body.sectionId)
      if (errAlunni) return rispostaGuastoDb('admin/competenze:POST', 'db:alunni', errAlunni)
      alunniIds = ((alunni ?? []) as { id: string }[]).map((a) => a.id)
    }

    // L'anno del certificato è quello della sua ETICHETTA (Ruling P49): l'`anno_scolastico` del periodo
    // dell'ultimo scrutinio finale chiuso, che è anche metà della chiave `(alunno_id, anno_scolastico)`.
    // Letta UNA volta per sezione, prima del ciclo. Senza scrutinio valido niente cambia: l'anno è il
    // `corrente` e l'errore di validazione lo restituisce `seedCertificato` per ogni alunno, come prima.
    const operazione = 'admin/competenze:POST'
    const validato = await validaScrutinioFinaleClasseQuinta(supabase, body.sectionId)
    let dichiarato: string | undefined
    if (validato.ok && validato.annoScolastico) {
      const daEtichetta = await annoDaEtichetta(supabase, validato.annoScolastico, operazione)
      if ('guasto' in daEtichetta) return daEtichetta.guasto
      if (!('indietro' in daEtichetta)) {
        if (daEtichetta.annoId === null) {
          logEvento('anno-scolastico', 'warn', { tipo: 'etichetta-non-di-un-anno', azione: operazione })
          return erroreAnno({ message: 'ANNO_NON_DELLA_SEDE' }, operazione) as NextResponse
        }
        dichiarato = daEtichetta.annoId
      }
    }

    let creati = 0
    const errori: { alunnoId: string; error?: string; status?: number; codice?: string; correzione_possibile?: true; etichetta?: string }[] = []
    let firstErrStatus: number | undefined
    for (const alunnoId of alunniIds) {
      // L'anno del certificato: quello della sua etichetta, nella sede DELLA SEZIONE (mai quella dell'operatore).
      // Un esito per alunno, perché un gettone vale una sola transazione e ogni certificato è una scrittura.
      const esito = await resolveAnnoScrittura(request, supabase, auth.user, scuolaSezione, { dichiarato, correzione: body.correzione })
      if (esito instanceof NextResponse) {
        const rifiuto = (await esito.json()) as { error?: string; codice?: string; correzione_possibile?: boolean; etichetta?: string }
        errori.push({
          alunnoId, error: rifiuto.error, status: esito.status, codice: rifiuto.codice,
          ...(rifiuto.correzione_possibile === true ? { correzione_possibile: true as const } : {}),
          ...(rifiuto.correzione_possibile === true && typeof rifiuto.etichetta === 'string' ? { etichetta: rifiuto.etichetta } : {}),
        })
        firstErrStatus = firstErrStatus ?? esito.status
        continue
      }
      const r = await seedCertificato(supabase, body.sectionId, alunnoId, esito, validato)
      if (r.error) {
        errori.push({ alunnoId, error: r.error, status: r.status, codice: r.codice })
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
    // Il codice di un rifiuto dell'anno (`ANNO_CHIUSO`…) sta in `errori[].codice`, per alunno.
    // `correzione_possibile` sale in cima, accanto al codice, perché la schermata decida se aprire il dialogo senza scorrere l'elenco.
    if (creati === 0 && firstErrStatus) {
      const possibile = errori.some((e) => e.correzione_possibile === true)
      // L'anno da correggere lo nomina il primo rifiuto che lo sa: il dialogo lo dice anche se la pagina non lo conosce.
      const etichetta = errori.find((e) => e.correzione_possibile === true && e.etichetta)?.etichetta
      return NextResponse.json(
        { error: errori[0].error, errori, ...(possibile ? { codice: 'ANNO_CHIUSO', correzione_possibile: true, ...(etichetta ? { etichetta } : {}) } : {}) },
        { status: firstErrStatus },
      )
    }
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
    const fuoriScopePatch = await assertSezioneScrivibile(supabase, auth.user, sectionId)
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
