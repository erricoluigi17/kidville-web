import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getModuleConfig } from '@/lib/settings/module-config'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola, staffScuola } from '@/lib/notifiche/destinatari'

// =============================================================================
// POST /api/notifiche/promemoria — giro promemoria GIORNALIERO.
// SERVICE-TO-SERVICE: header `x-cron-secret` (pattern /api/push/dispatch).
// Lo invoca pg_cron via notifiche_promemoria_tick() (migr 20260712180000).
//
// Tre scansioni, ognuna best-effort e gated dal proprio toggle notifiche:
//  1. moduli non compilati (avvisi con form_model_id, dopo N giorni —
//     admin_settings.modulistica_config.promemoria_giorni, default 3)
//  2. richieste armadietto pending mai ricordate (locker_requests,
//     reminder_inviato_il NULL — sostituisce la edge fn locker-reminder simulata)
//  3. documenti alunno in scadenza ≤30gg → segreteria (sostituisce la edge fn
//     document-expiry-alert, storicamente rotta: colonne inesistenti)
// Ogni tabella può mancare su ambienti non migrati (DB E2E CI) → skip.
// =============================================================================

const MS_GIORNO = 86_400_000

function tabellaMancante(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42P01' || /does not exist|schema cache|could not find/i.test(error.message ?? '')
}

export async function POST(request: Request) {
  const secret = request.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const supabase = await createAdminClient()
  const oggi = new Date().toISOString().slice(0, 10)
  const esiti = { moduli: 0, armadietto: 0, documenti: 0 }

  // ── 1. Moduli non compilati ────────────────────────────────────────────────
  try {
    const { data: avvisi, error } = await supabase
      .from('avvisi')
      .select('id, titolo, target_scope, target_classes, scadenza, created_at, scuola_id, form_model_id')
      .not('form_model_id', 'is', null)
      .or(`scadenza.is.null,scadenza.gte.${oggi}`)
    if (error && !tabellaMancante(error)) throw error

    const cfgGiorni = new Map<string, number>()
    for (const avviso of (avvisi ?? []) as Array<{
      id: string; titolo: string; target_scope: string | null; target_classes: string[] | null
      created_at: string; scuola_id: string | null; form_model_id: string
    }>) {
      const scuolaId = avviso.scuola_id
      if (!cfgGiorni.has(scuolaId ?? '')) {
        const cfg = await getModuleConfig<{ promemoria_giorni?: number }>(supabase, 'modulistica_config', scuolaId)
        cfgGiorni.set(scuolaId ?? '', Number(cfg?.promemoria_giorni ?? 3))
      }
      const giorni = cfgGiorni.get(scuolaId ?? '') ?? 3
      if (giorni <= 0) continue // 0 = promemoria disattivati per la scuola
      if (Date.now() - Date.parse(avviso.created_at) < giorni * MS_GIORNO) continue

      // Destinatari target dell'avviso (stessa risoluzione della pubblicazione).
      const classi = (avviso.target_classes ?? []).filter(Boolean)
      const globale = (avviso.target_scope ?? 'globale') === 'globale' || classi.length === 0
      const target = globale
        ? await genitoriDiScuola(supabase, scuolaId)
        : await genitoriDiClassi(supabase, scuolaId, classi)
      if (target.length === 0) continue

      // Escludi chi ha già compilato il modulo…
      const { data: fatte } = await supabase
        .from('form_submissions')
        .select('user_id')
        .eq('model_id', avviso.form_model_id)
      const compilatori = new Set((fatte ?? []).map((s) => s.user_id as string).filter(Boolean))
      // …e chi ha già ricevuto un promemoria negli ultimi N giorni (dedup su
      // `notifiche` stessa: nessuna colonna nuova).
      const cutoff = new Date(Date.now() - giorni * MS_GIORNO).toISOString()
      const { data: recenti } = await supabase
        .from('notifiche')
        .select('utente_id')
        .eq('tipo', 'modulo_promemoria')
        .eq('entita_id', avviso.id)
        .gte('creato_il', cutoff)
      const giaRicordati = new Set((recenti ?? []).map((n) => n.utente_id as string))

      const destinatari = target.filter((uid) => !compilatori.has(uid) && !giaRicordati.has(uid))
      if (destinatari.length === 0) continue

      await notificaEvento(supabase, {
        tipo: 'modulo_promemoria',
        scuolaId,
        utenteIds: destinatari,
        titolo: `Promemoria: modulo da compilare`,
        corpo: `Il modulo «${avviso.titolo}» risulta ancora da compilare.`,
        link: '/parent/modulistica',
        entitaTipo: 'avviso',
        entitaId: avviso.id,
        bufferMin: 0,
      })
      esiti.moduli += destinatari.length
    }
  } catch (e) {
    console.error('[promemoria] scansione moduli fallita (non bloccante):', e)
  }

  // ── 2. Richieste armadietto pending ───────────────────────────────────────
  try {
    const { data: richieste, error } = await supabase
      .from('locker_requests')
      .select('id, alunno_id, quantita_residua, locker_catalog (nome, unita)')
      .eq('stato', 'pending')
      .is('reminder_inviato_il', null)
    if (error) {
      if (!tabellaMancante(error)) throw error
    } else {
      for (const r of (richieste ?? []) as Array<{
        id: string; alunno_id: string; quantita_residua: number | null
        locker_catalog: { nome?: string | null; unita?: string | null } | { nome?: string | null; unita?: string | null }[] | null
      }>) {
        const cat = Array.isArray(r.locker_catalog) ? r.locker_catalog[0] : r.locker_catalog
        const { data: alunno } = await supabase
          .from('alunni')
          .select('nome, scuola_id')
          .eq('id', r.alunno_id)
          .maybeSingle()
        const genitori = await genitoriDiAlunni(supabase, [r.alunno_id])
        if (genitori.length > 0) {
          await notificaEvento(supabase, {
            tipo: 'locker_richiesta',
            scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
            utenteIds: genitori,
            titolo: 'Materiale da portare a scuola',
            corpo: `${cat?.nome ?? 'Materiale'} in esaurimento per ${alunno?.nome ?? 'tuo figlio'}${r.quantita_residua != null ? ` (${r.quantita_residua} ${cat?.unita ?? 'pz'} rimasti)` : ''}.`,
            link: '/parent/locker',
            entitaTipo: 'locker_request',
            entitaId: r.id,
            bufferMin: 0,
          })
          esiti.armadietto += 1
        }
        await supabase
          .from('locker_requests')
          .update({ reminder_inviato_il: new Date().toISOString() })
          .eq('id', r.id)
      }
    }
  } catch (e) {
    console.error('[promemoria] scansione armadietto fallita (non bloccante):', e)
  }

  // ── 3. Documenti in scadenza (≤30 giorni) → segreteria ────────────────────
  try {
    const soglia = new Date(Date.now() + 30 * MS_GIORNO).toISOString().slice(0, 10)
    const { data: docs, error } = await supabase
      .from('student_documents')
      .select('id, student_id, document_type, expiry_date')
      .lte('expiry_date', soglia)
    if (error) {
      if (!tabellaMancante(error)) throw error
    } else {
      for (const doc of (docs ?? []) as Array<{ id: string; student_id: string; document_type: string | null; expiry_date: string | null }>) {
        // Dedup: un solo avviso per documento (qualsiasi data).
        const { data: gia } = await supabase
          .from('notifiche')
          .select('id')
          .eq('tipo', 'documenti_scadenza')
          .eq('entita_id', doc.id)
          .limit(1)
        if (gia && gia.length > 0) continue

        const { data: alunno } = await supabase
          .from('alunni')
          .select('nome, cognome, scuola_id')
          .eq('id', doc.student_id)
          .maybeSingle()
        const scuolaId = (alunno?.scuola_id as string | undefined) ?? null
        const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria'])
        if (destinatari.length === 0) continue

        await notificaEvento(supabase, {
          tipo: 'documenti_scadenza',
          scuolaId,
          utenteIds: destinatari,
          titolo: `Documento in scadenza: ${(doc.document_type ?? 'documento').toUpperCase()}`,
          corpo: `Il documento di ${[alunno?.nome, alunno?.cognome].filter(Boolean).join(' ') || 'un alunno'} scade il ${doc.expiry_date ?? '—'}.`,
          link: '/admin/students',
          entitaTipo: 'documento',
          entitaId: doc.id,
          bufferMin: 0,
        })
        esiti.documenti += 1
      }
    }
  } catch (e) {
    console.error('[promemoria] scansione documenti fallita (non bloccante):', e)
  }

  return NextResponse.json({ success: true, data: esiti })
}
