import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { patchAlunno, patchParent, confermaValida } from '@/lib/gdpr/anonimizza'
import { parentHaAltriFigliIscritti } from '@/lib/gdpr/orfano'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `alunno_id`: contratto storico permissivo (qualunque stringa non vuota; id
// inesistente → 404 a valle, niente vincolo uuid). `mode`: stessi valori del
// check manuale sostituito. `confirm`: verificato da `confermaValida` solo in
// mode=execute (400 dedicato a valle) — .optional() esplicito perché in zod v4
// z.unknown() come chiave di z.object è required a runtime.
const postBodySchema = z.object({
  alunno_id: z.string().min(1),
  mode: z.enum(['dryrun', 'execute']),
  confirm: z.unknown().optional(),
})

// Diritto all'oblio (DL-034). SOLO anonimizzazione (no DELETE), preserva audit +
// fisco, dry-run + doppia conferma. Riservato alla Direzione.

const DIREZIONE = ['admin', 'coordinator'] as const

export const POST = withRoute('admin/gdpr/erase:POST', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id, mode, confirm } = b.data

  try {
    const supabase = await createAdminClient()
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, cognome, stato, anonimizzato_il, documento_path')
      .eq('id', alunno_id)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Si cancella SOLO un alunno non iscritto (diritto all'oblio post-uscita).
    if (alunno.stato === 'iscritto') {
      return NextResponse.json(
        { error: 'Operazione consentita solo su alunni non iscritti' },
        { status: 409 }
      )
    }

    // Genitori collegati (anagrafica reale `parents` via `student_parents`).
    const { data: links } = await supabase
      .from('student_parents')
      .select('parent_id')
      .eq('student_id', alunno_id)
    const parentIds = (links ?? []).map((l: { parent_id: string }) => l.parent_id)

    // Genitori "orfani" (nessun altro figlio iscritto) → anonimizzabili.
    const parentiOrfani: string[] = []
    for (const pid of parentIds) {
      const altri = await parentHaAltriFigliIscritti(supabase, pid, alunno_id)
      if (!altri) parentiOrfani.push(pid)
    }

    // File PII da rimuovere (binari non anonimizzabili). Il bucket `fatture` è ESCLUSO
    // (conservazione fiscale). `documento_path` dell'alunno (se presente).
    const fileAlunno = alunno.documento_path ? [String(alunno.documento_path)] : []

    if (mode === 'dryrun') {
      return NextResponse.json({
        dryrun: true,
        alunno: 1,
        parents: parentiOrfani.length,
        parents_non_anonimizzati: parentIds.length - parentiOrfani.length,
        file_da_rimuovere: fileAlunno.length,
        nominativo_conferma: `${(alunno.cognome ?? '').trim()} ${(alunno.nome ?? '').trim()}`.trim().toUpperCase(),
      })
    }

    // execute: doppia conferma sul nominativo.
    if (!confermaValida(confirm, alunno)) {
      return NextResponse.json(
        { error: 'Conferma non valida: digita ESATTAMENTE il nominativo (Cognome Nome)' },
        { status: 400 }
      )
    }

    const at = new Date().toISOString()

    // 1. Anonimizza l'alunno.
    await supabase.from('alunni').update(patchAlunno(alunno_id, at)).eq('id', alunno_id)

    // 2. Anonimizza i genitori orfani.
    for (const pid of parentiOrfani) {
      await supabase.from('parents').update(patchParent(pid, at)).eq('id', pid)
    }

    // 3. Rimuovi i file PII (escluso il bucket fatture). Best-effort.
    if (fileAlunno.length > 0) {
      try {
        await supabase.storage.from('form_attachments').remove(fileAlunno)
      } catch {
        /* file già assente o bucket diverso: ignora */
      }
    }

    // 4. Log immutabile dell'oblio.
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'gdpr_oblio',
      entitaId: alunno_id,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
      valoreDopo: { alunno_id, parents_anonimizzati: parentiOrfani, file_rimossi: fileAlunno.length },
    })

    return NextResponse.json({
      ok: true,
      alunno: 1,
      parents: parentiOrfani.length,
      file_rimossi: fileAlunno.length,
    })
  } catch (err) {
    logErrore({ operazione: 'admin/gdpr/erase:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
