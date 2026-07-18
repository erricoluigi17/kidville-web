import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import { famigliaDiAlunno } from '@/lib/pagamenti/sospensione'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Comportamento storico preservato: `sospeso` conta solo se strettamente === true,
// `motivo` è usato solo se stringa — qualunque altro valore è tollerato (→ false/null).
// NB zod v4: z.unknown() come chiave è required a runtime, serve .optional().
// Contabilità v2: in alternativa ad `alunno_id` si accetta `parent_account_id`
// (utenti.id del genitore) → si sospende TUTTA la famiglia (unione legami).
const postBodySchema = z
  .object({
    alunno_id: zUuid.optional(),
    parent_account_id: zUuid.optional(),
    sospeso: z.unknown().optional(),
    motivo: z.unknown().optional(),
    causa: z.enum(['morosita', 'altro']).default('morosita'),
  })
  .refine((b) => !!b.alunno_id || !!b.parent_account_id, {
    message: 'alunno_id o parent_account_id obbligatorio',
  })

// Applica sospeso/riattivazione a UN alunno. Scrive `sospeso_causa` best-effort:
// se la colonna manca sul DB non migrato (PGRST204/42703) ritenta senza. Ritorna
// l'eventuale errore PostgREST (che NON lancia: va controllato dal chiamante).
async function applicaSospensione(
  supabase: SupabaseClient,
  args: { alunnoId: string; sospeso: boolean; motivo: string | null; causa: 'morosita' | 'altro'; attoreId: string }
): Promise<{ error: { message?: string; code?: string } | null }> {
  const base = args.sospeso
    ? { sospeso: true, sospeso_motivo: args.motivo, sospeso_il: new Date().toISOString(), sospeso_da: args.attoreId }
    : { sospeso: false, sospeso_motivo: null, sospeso_il: null, sospeso_da: args.attoreId }
  const conCausa = args.sospeso ? { ...base, sospeso_causa: args.causa } : { ...base, sospeso_causa: null }

  let res = await supabase.from('alunni').update(conCausa).eq('id', args.alunnoId)
  if (res.error && ['PGRST204', '42703'].includes((res.error as { code?: string }).code ?? '')) {
    res = await supabase.from('alunni').update(base).eq('id', args.alunnoId)
  }
  return { error: res.error }
}

const getQuerySchema = z.object({ alunno_id: zUuid })

// GET /api/admin/pagamenti/sospensione?alunno_id=  (Direzione) — anteprima
// famiglia: i figli che verrebbero coinvolti dalla sospensione (granularità
// famiglia) + un account genitore su cui applicarla. Serve alla conferma della UI.
export const GET = withRoute('admin/pagamenti/sospensione:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const scopeErr = await assertAlunnoInScope(supabase, auth.user, q.data.alunno_id)
    if (scopeErr) return scopeErr

    const info = await famigliaDiAlunno(supabase, q.data.alunno_id)
    return NextResponse.json({ success: true, data: info })
  } catch (err) {
    logErrore({ operazione: 'admin/pagamenti/sospensione:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/admin/pagamenti/sospensione  (Direzione) — sospende/riattiva per
// morosità (DL-021). Body: { alunno_id | parent_account_id, sospeso, motivo?, causa? }.
// Azione manuale e consapevole, riservata alla Direzione (admin/coordinator).
export const POST = withRoute('admin/pagamenti/sospensione:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const sospeso = b.data.sospeso === true
    const motivo = typeof b.data.motivo === 'string' ? b.data.motivo : null
    const causa = b.data.causa

    const supabase = await createAdminClient()

    // Alunni target: singolo, oppure TUTTA la famiglia (unione legami).
    let alunnoIds: string[]
    if (b.data.parent_account_id) {
      alunnoIds = await getFigliDiGenitore(supabase, b.data.parent_account_id)
      if (alunnoIds.length === 0) {
        return NextResponse.json({ error: 'Nessun figlio collegato a questo genitore' }, { status: 404 })
      }
    } else {
      alunnoIds = [b.data.alunno_id as string]
    }

    // Scope tenant su OGNI alunno.
    for (const alunnoId of alunnoIds) {
      const scopeErr = await assertAlunnoInScope(supabase, auth.user, alunnoId)
      if (scopeErr) return scopeErr
    }

    const applicati: string[] = []
    for (const alunnoId of alunnoIds) {
      const { error } = await applicaSospensione(supabase, { alunnoId, sospeso, motivo, causa, attoreId: auth.user.id })
      if (error) {
        logEvento('pagamento', 'error', {
          operazione: 'admin/pagamenti/sospensione:POST',
          esito: 'update-sospensione-fallita',
          alunno_id: alunnoId,
        }, error)
        // Modalità famiglia: prosegui con gli altri figli; modalità singola: 500.
        if (!b.data.parent_account_id) {
          return NextResponse.json({ error: error.message ?? 'Aggiornamento fallito' }, { status: 500 })
        }
        continue
      }
      applicati.push(alunnoId)
    }

    if (applicati.length === 0) {
      return NextResponse.json({ error: 'Nessuna sospensione applicata' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'sospensione',
      entitaId: b.data.parent_account_id ?? applicati[0],
      azione: sospeso ? 'insert' : 'delete',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { sospeso, causa, motivo, figli: applicati.length },
    })

    // Notifica formale al genitore (best-effort). Testo NEUTRO in push
    // (privacy: il dettaglio si legge in-app); anche la riattivazione avvisa.
    try {
      const { data: alunno } = await supabase
        .from('alunni').select('scuola_id').eq('id', applicati[0]).maybeSingle()
      await notificaEvento(supabase, {
        tipo: 'sospensione_morosita',
        scuolaId: (alunno?.scuola_id as string | undefined) ?? auth.user.scuola_id ?? null,
        alunnoIds: applicati,
        titolo: 'Avviso amministrativo',
        corpo: sospeso
          ? 'C’è una comunicazione amministrativa importante: apri la sezione Pagamenti.'
          : 'Il servizio è stato riattivato. Dettagli nella sezione Pagamenti.',
        link: '/parent/pagamenti',
        entitaTipo: 'sospensione',
        entitaId: applicati[0],
        bufferMin: 0,
      })
    } catch (e) {
      // La sospensione è stata APPLICATA (200), ma l'avviso formale al genitore non è
      // partito: il servizio si interrompe senza che nessuno l'abbia comunicato. È il
      // caso peggiore di scrittura persa — `error`, non `warn`.
      logEvento('notifica', 'error', {
        operazione: 'admin/pagamenti/sospensione:POST',
        esito: 'notifica-sospensione-non-inviata',
        tipo: 'sospensione_morosita',
        stato: sospeso ? 'sospeso' : 'riattivato',
      }, e)
    }

    return NextResponse.json({ success: true, data: { alunni: applicati, sospeso, causa } })
  } catch (err) {
    logErrore({ operazione: 'admin/pagamenti/sospensione:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
