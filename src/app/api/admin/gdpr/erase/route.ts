import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { patchAlunno, patchParent, confermaValida, scrubSuggerimenti } from '@/lib/gdpr/anonimizza'
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
      .select('id, nome, cognome, stato, anonimizzato_il, documento_path, codice_fiscale, fiscal_code')
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

    // 3. Bonifica dei dati di riconciliazione/incassi COLLEGATI (D1). La causale
    //    consigliata porta CF+nome del minore, che finiscono persistiti nei movimenti
    //    (causale/controparte/suggerimenti.label), copiati nella nota dell'incasso
    //    («Riconciliazione: …»): senza questo passo il CF resterebbe leggibile a tempo
    //    indefinito dopo l'oblio. Il CF va letto PRIMA (patchAlunno l'ha già azzerato in DB,
    //    ma `alunno` è il record letto in cima). Nessuna PII nei log: solo conteggi/uuid.
    const cfAlunno = [alunno.codice_fiscale, alunno.fiscal_code]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0) ?? ''
    let riconciliazioneBonificati = 0
    let incassiBonificati = 0
    let cassaBonificati = 0

    // Pagamenti dell'alunno anonimizzato (l'aggancio movimento→alunno passa dal pagamento).
    const { data: pagRows, error: errPag } = await supabase
      .from('pagamenti')
      .select('id')
      .eq('alunno_id', alunno_id)
    if (errPag) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_pagamenti' }, errPag)
    const pagIds = ((pagRows ?? []) as { id: string }[]).map((p) => p.id)

    if (pagIds.length > 0) {
      // 3a. Movimenti CONFERMATI collegati → azzera causale/controparte, scrub del `label`
      //     (nome+cognome) nei suggerimenti. Per-riga: il patch dei suggerimenti dipende
      //     dal valore esistente.
      const { data: movConf, error: errMovSel } = await supabase
        .from('riconciliazione_movimenti')
        .select('id, suggerimenti')
        .in('pagamento_id', pagIds)
        .eq('stato', 'confermato')
      if (errMovSel) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_riconciliazione_select' }, errMovSel)
      for (const m of (movConf ?? []) as { id: string; suggerimenti: unknown }[]) {
        const { error: errU } = await supabase
          .from('riconciliazione_movimenti')
          .update({ causale: null, controparte: null, suggerimenti: scrubSuggerimenti(m.suggerimenti) })
          .eq('id', m.id)
        if (errU) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_riconciliazione_update' }, errU)
        else riconciliazioneBonificati++
      }

      // 3b. Incassi generati dalla riconciliazione (nota «Riconciliazione: …») → azzera la nota.
      const { data: incBon, error: errInc } = await supabase
        .from('incassi')
        .update({ note: null })
        .in('pagamento_id', pagIds)
        .ilike('note', 'Riconciliazione:%')
        .select('id')
      if (errInc) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_incassi' }, errInc)
      else incassiBonificati = (incBon ?? []).length
    }

    // 3c. Best-effort: movimenti NON confermati la cui causale cita il CF dell'alunno.
    //     (Il CF è alfanumerico puro: nessun metacarattere ILIKE da escapare.)
    if (cfAlunno) {
      const { data: movCf, error: errMovCf } = await supabase
        .from('riconciliazione_movimenti')
        .update({ causale: null, controparte: null })
        .neq('stato', 'confermato')
        .ilike('causale', `%${cfAlunno}%`)
        .select('id')
      if (errMovCf) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_riconciliazione_cf' }, errMovCf)
      else riconciliazioneBonificati += (movCf ?? []).length
    }

    // 3d. Movimenti NON confermati agganciati all'alunno tramite i `suggerimenti`
    //     (match per CF/nome all'import, senza `pagamento_id` top-level ancora): il
    //     `label` porta «Nome Cognome» del minore. Azzera causale/controparte e fa lo
    //     scrub del `label`. Senza questo, l'oblio lascerebbe il nome nel JSON persistito.
    if (pagIds.length > 0) {
      const pagSet = new Set(pagIds)
      const { data: movNc, error: errNcSel } = await supabase
        .from('riconciliazione_movimenti')
        .select('id, suggerimenti')
        .neq('stato', 'confermato')
      if (errNcSel) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_riconciliazione_nonconf_select' }, errNcSel)
      for (const m of (movNc ?? []) as { id: string; suggerimenti: unknown }[]) {
        const sugg = Array.isArray(m.suggerimenti) ? (m.suggerimenti as Record<string, unknown>[]) : []
        const riferito = sugg.some(
          (s) => s && typeof s === 'object' && pagSet.has(String((s as { pagamento_id?: unknown }).pagamento_id)),
        )
        if (!riferito) continue
        const { error: errU } = await supabase
          .from('riconciliazione_movimenti')
          .update({ causale: null, controparte: null, suggerimenti: scrubSuggerimenti(m.suggerimenti) })
          .eq('id', m.id)
        if (errU) logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_riconciliazione_nonconf_update' }, errU)
        else riconciliazioneBonificati++
      }
    }

    // 3e. Bonifica del TESTO LIBERO dei movimenti di cassa che citano il CF (P6).
    //     `cassa_movimenti` NON ha `alunno_id`: l'unico aggancio al minore è il CF
    //     eventualmente scritto in descrizione/note/storno_motivo (es. categoria
    //     «Rimborsi»). Senza questa passata il CF/nome sopravviverebbe all'oblio a
    //     tempo indefinito. Pattern ILIKE-per-CF come 3c; il CF è alfanumerico puro
    //     (nessun metacarattere ILIKE/`.or()` da escapare). Degrada in silenzio se lo
    //     schema cassa è assente (DB E2E CI non migrato).
    if (cfAlunno) {
      const like = `%${cfAlunno}%`
      const { data: cassaBon, error: errCassa } = await supabase
        .from('cassa_movimenti')
        .update({ descrizione: '[rimosso]', note: '[rimosso]', storno_motivo: '[rimosso]' })
        .or(`descrizione.ilike.${like},note.ilike.${like},storno_motivo.ilike.${like}`)
        .select('id')
      if (errCassa) {
        const code = (errCassa as { code?: string }).code ?? ''
        const CASSA_SCHEMA_ASSENTE = ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205']
        if (!CASSA_SCHEMA_ASSENTE.includes(code)) {
          logErrore({ operazione: 'admin/gdpr/erase:POST', evento: 'bonifica_cassa' }, errCassa)
        }
      } else {
        cassaBonificati = (cassaBon ?? []).length
      }
    }

    // 4. Rimuovi i file PII (escluso il bucket fatture). Best-effort.
    if (fileAlunno.length > 0) {
      try {
        await supabase.storage.from('form_attachments').remove(fileAlunno)
      } catch {
        /* file già assente o bucket diverso: ignora */
      }
    }

    // 5. Log immutabile dell'oblio (solo conteggi/uuid: nessuna PII).
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'gdpr_oblio',
      entitaId: alunno_id,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
      valoreDopo: {
        alunno_id,
        parents_anonimizzati: parentiOrfani,
        file_rimossi: fileAlunno.length,
        riconciliazione_bonificati: riconciliazioneBonificati,
        incassi_bonificati: incassiBonificati,
        cassa_bonificati: cassaBonificati,
      },
    })

    return NextResponse.json({
      ok: true,
      alunno: 1,
      parents: parentiOrfani.length,
      file_rimossi: fileAlunno.length,
      riconciliazione_bonificati: riconciliazioneBonificati,
      incassi_bonificati: incassiBonificati,
      cassa_bonificati: cassaBonificati,
    })
  } catch (err) {
    logErrore({ operazione: 'admin/gdpr/erase:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
