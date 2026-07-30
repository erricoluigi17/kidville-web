import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { anonimizzaParent, anonimizzaAlunno, type AlunnoOblio } from '@/lib/gdpr/esegui'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// Evasione delle richieste di cancellazione account (Direzione).
// GET: elenco richieste pending arricchito (nome genitore + figli). POST: dry-run
// / execute → anonimizza il genitore + i figli NON iscritti (i figli iscritti
// restano: la scuola è titolare del trattamento per gli iscritti).
// =============================================================================

const DIREZIONE = ['admin', 'coordinator'] as const
const CONFERMA = 'ANONIMIZZA'

const postBodySchema = z.object({
  id: z.string().min(1),
  mode: z.enum(['dryrun', 'execute']),
  confirm: z.unknown().optional(),
})

export const GET = withRoute('admin/gdpr/richieste:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response
  try {
    const admin = await createAdminClient()
    // Isolamento per sede: la colonna `scuola_id` c'era già su questa tabella e
    // veniva LETTA nella POST, ma non confrontata con niente — e qui non era
    // nemmeno letta. Scope vuoto ⇒ nessuna richiesta.
    const plessi = await resolveScuoleAttive(request, admin, auth.user)
    const { data: richieste, error } = await admin
      .from('richieste_cancellazione')
      .select('id, parent_id, creata_il')
      .in('scuola_id', plessi)
      .eq('stato', 'pending')
      .order('creata_il', { ascending: true })
    if (error) {
      if (schemaAssente(error)) return NextResponse.json([])
      logErrore({ operazione: 'admin/gdpr/richieste:GET', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    const rows = (richieste ?? []) as { id: string; parent_id: string; creata_il: string }[]
    const out: Array<Record<string, unknown>> = []
    for (const r of rows) {
      const { data: parent } = await admin
        .from('parents')
        .select('first_name, last_name')
        .eq('id', r.parent_id)
        .maybeSingle()
      const nome = parent
        ? `${(parent.first_name ?? '').toString().trim()} ${(parent.last_name ?? '').toString().trim()}`.trim()
        : ''

      const { data: links } = await admin.from('student_parents').select('student_id').eq('parent_id', r.parent_id)
      const childIds = ((links ?? []) as { student_id: string }[]).map((l) => l.student_id)
      let iscritti = 0
      let nonIscritti = 0
      if (childIds.length > 0) {
        const { data: figli } = await admin.from('alunni').select('id, stato, anonimizzato_il').in('id', childIds)
        for (const f of (figli ?? []) as { stato: string | null; anonimizzato_il: string | null }[]) {
          if (f.anonimizzato_il) continue
          if (f.stato === 'iscritto') iscritti++
          else nonIscritti++
        }
      }
      out.push({
        id: r.id,
        creata_il: r.creata_il,
        parent_nome: nome || '—',
        alunni_iscritti: iscritti,
        alunni_non_iscritti: nonIscritti,
      })
    }
    return NextResponse.json(out)
  } catch (err) {
    logErrore({ operazione: 'admin/gdpr/richieste:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

export const POST = withRoute('admin/gdpr/richieste:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { id, mode, confirm } = b.data

  try {
    const admin = await createAdminClient()
    const { data: richiesta, error: errR } = await admin
      .from('richieste_cancellazione')
      .select('id, parent_id, stato, scuola_id')
      .eq('id', id)
      .maybeSingle()
    if (errR) {
      if (schemaAssente(errR)) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 })
      logErrore({ operazione: 'admin/gdpr/richieste:POST', stato: 500 }, errR)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!richiesta) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 })

    // Isolamento per sede, PRIMA di anonimizzare: `scuola_id` era letto e mai
    // confrontato. Una sede nulla ⇒ si NEGA, non si apre: non c'è modo di
    // stabilire il plesso e questa operazione è irreversibile. In produzione la
    // tabella è vuota (verificato il 2026-07-30), quindi la regola stretta non
    // lascia indietro nessuna richiesta già presentata.
    const plessi = await resolveScuoleAttive(request, admin, auth.user)
    const sedeRichiesta = (richiesta.scuola_id as string | null) ?? null
    if (!sedeRichiesta || !plessi.includes(sedeRichiesta)) {
      return NextResponse.json({ error: 'Richiesta fuori dal tuo plesso' }, { status: 403 })
    }

    if (richiesta.stato !== 'pending') {
      return NextResponse.json({ error: 'Richiesta già gestita' }, { status: 409 })
    }

    const parentId = richiesta.parent_id as string

    // Figli collegati + stato di iscrizione.
    const { data: links } = await admin.from('student_parents').select('student_id').eq('parent_id', parentId)
    const childIds = ((links ?? []) as { student_id: string }[]).map((l) => l.student_id)
    type Figlio = {
      id: string
      stato: string | null
      anonimizzato_il: string | null
      documento_path: string | null
      codice_fiscale: string | null
      fiscal_code: string | null
    }
    let figli: Figlio[] = []
    if (childIds.length > 0) {
      const { data } = await admin
        .from('alunni')
        .select('id, stato, anonimizzato_il, documento_path, codice_fiscale, fiscal_code')
        .in('id', childIds)
      figli = (data ?? []) as Figlio[]
    }
    const nonIscritti = figli.filter((f) => !f.anonimizzato_il && f.stato !== 'iscritto')
    const iscrittiMantenuti = figli.filter((f) => !f.anonimizzato_il && f.stato === 'iscritto').length

    if (mode === 'dryrun') {
      return NextResponse.json({
        dryrun: true,
        parent: 1,
        alunni_non_iscritti: nonIscritti.length,
        alunni_iscritti_mantenuti: iscrittiMantenuti,
      })
    }

    // execute: conferma testuale.
    if (typeof confirm !== 'string' || confirm.trim().toUpperCase() !== CONFERMA) {
      return NextResponse.json({ error: `Conferma non valida: digita ${CONFERMA}` }, { status: 400 })
    }

    const at = new Date().toISOString()
    const op = 'admin/gdpr/richieste:POST'

    // 1. Anonimizza il genitore richiedente.
    const rParent = await anonimizzaParent(admin, parentId, at, op)
    const newsVisualizzazioniRimosse = rParent.newsVisualizzazioniRimosse
    let segnalazioni = rParent.segnalazioniBonificate
    let sospensioni = rParent.sospensioniBonificate

    // 2. Anonimizza i figli NON iscritti + bonifica finanziaria/UGC collegata.
    let ricon = 0
    let incassi = 0
    let cassa = 0
    let file = 0
    for (const f of nonIscritti) {
      const r = await anonimizzaAlunno(admin, f as AlunnoOblio, at, op)
      ricon += r.riconciliazione
      incassi += r.incassi
      cassa += r.cassa
      file += r.file
      segnalazioni += r.segnalazioniBonificate
      sospensioni += r.sospensioniBonificate
    }

    const esito = {
      parent: 1,
      alunni: nonIscritti.length,
      news_visualizzazioni_rimosse: newsVisualizzazioniRimosse,
      riconciliazione_bonificati: ricon,
      incassi_bonificati: incassi,
      cassa_bonificati: cassa,
      file_rimossi: file,
      segnalazioni_bonificate: segnalazioni,
      sospensioni_bonificate: sospensioni,
    }

    // 3. Marca la richiesta come evasa.
    const { error: errUpd } = await admin
      .from('richieste_cancellazione')
      .update({ stato: 'evasa', evasa_il: at, evasa_da: auth.user.id, aggiornata_il: at, esito })
      .eq('id', id)
    if (errUpd) logErrore({ operazione: op, evento: 'marca_evasa' }, errUpd)

    // 4. Audit immutabile (solo conteggi/uuid: nessuna PII).
    await logScrittura(admin, {
      attore: auth.user,
      entitaTipo: 'gdpr_richiesta_cancellazione',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
      valoreDopo: { parent_id: parentId, ...esito },
    })

    return NextResponse.json({ ok: true, ...esito })
  } catch (err) {
    logErrore({ operazione: 'admin/gdpr/richieste:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
