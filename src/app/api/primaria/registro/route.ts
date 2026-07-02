import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { isOltreScadenza } from '@/lib/primaria/timelock'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'

// ISO date → giorno_settimana 1..6 (Lun..Sab); domenica (0) → 7 (fuori range).
function giornoSettimana(dataIso: string): number {
  const d = new Date(dataIso + 'T00:00:00').getDay() // 0=Dom..6=Sab
  return d === 0 ? 7 : d
}

// GET /api/primaria/registro?sectionId=&data=&userId=
// Restituisce la griglia del giorno: campanelle (con orario pre-compilato) +
// righe di registro firmate (con firme, contenuti propri e destinatari).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const data = sp.get('data')
    if (!sectionId || !data) return NextResponse.json({ error: 'sectionId e data obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const giorno = giornoSettimana(data)

    // NB: niente embed `utenti(...)` nei join — la relazione firme_docenti/
    // orario_settimanale → utenti non è nel cache PostgREST e farebbe fallire
    // l'intera query (la firma non comparirebbe). I nomi docente si risolvono a parte.
    const [{ data: campanelle }, { data: orarioCelle }, { data: righe }] = await Promise.all([
      supabase
        .from('campanelle')
        .select('id, ordine, ora_inizio, ora_fine, tipo')
        .eq('section_id', sectionId)
        .eq('giorno_settimana', giorno)
        .order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('campanella_id, materia_id, docente_id, materie(nome, codice)')
        .eq('section_id', sectionId)
        .eq('giorno_settimana', giorno),
      supabase
        .from('registro_orario')
        .select(`
          id, ora_lezione, materia, materia_id, argomento, compiti, data_consegna_compiti, locked_il,
          materie(nome, codice),
          firme_docenti(id, maestra_id, tipo_compresenza, argomento_proprio, compiti_propri, firmato_il),
          registro_destinatari(id, firma_id, alunno_id),
          allegati_registro(id, ambito, tipo, file_url, file_name)
        `)
        .eq('section_id', sectionId)
        .eq('data', data)
        .order('ora_lezione'),
    ])

    // Risoluzione nomi docente (firme + orario) senza dipendere dalle FK del cache.
    const docenteIds = new Set<string>()
    for (const c of orarioCelle ?? []) if (c.docente_id) docenteIds.add(c.docente_id as string)
    for (const r of righe ?? []) for (const f of (r.firme_docenti ?? []) as { maestra_id: string }[]) if (f.maestra_id) docenteIds.add(f.maestra_id)
    const nomiById = new Map<string, { nome: string; cognome: string }>()
    if (docenteIds.size) {
      const { data: docenti } = await supabase.from('utenti').select('id, nome, cognome').in('id', [...docenteIds])
      for (const d of docenti ?? []) nomiById.set(d.id, { nome: d.nome, cognome: d.cognome })
    }
    const orarioConNomi = (orarioCelle ?? []).map((c) => ({ ...c, utenti: c.docente_id ? nomiById.get(c.docente_id as string) ?? null : null }))
    const righeConNomi = (righe ?? []).map((r) => ({
      ...r,
      firme_docenti: ((r.firme_docenti ?? []) as { maestra_id: string }[]).map((f) => ({ ...f, utenti: nomiById.get(f.maestra_id) ?? null })),
    }))

    return NextResponse.json({
      success: true,
      data: { giorno, campanelle: campanelle ?? [], orarioCelle: orarioConNomi, righe: righeConNomi },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/registro?userId=
// Firma/salva una lezione. Gestisce cofirma e firma indipendente (destinatari).
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const {
      sectionId,
      data,
      oraLezione,
      materiaId,
      argomento,
      compiti,
      dataConsegnaCompiti,
      tipoCompresenza = 'principale',
      argomentoProprio,
      compitiPropri,
      destinatariIds = [],
    } = body

    if (!sectionId || !data || !oraLezione) {
      return NextResponse.json({ error: 'sectionId, data, oraLezione obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Scope per tenant/classe (educator: solo sezioni assegnate; staff/segreteria: plesso).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // I destinatari (oscuramento firma indipendente) devono essere alunni della sezione.
    if (Array.isArray(destinatariIds) && destinatariIds.length > 0) {
      const alunniErr = await assertAlunniInSezione(supabase, destinatariIds, sectionId)
      if (alunniErr) return alunniErr
    }

    // La FIRMA del registro deve restare del docente (vincolo FEA). educator → sé
    // stesso; segreteria → docente titolare indicato in body.docenteId, altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId: body.docenteId, materiaId })
    if (vr.response) return vr.response
    const firmaUserId = vr.valutatoreId

    // Risolve scuola + nome classe (classe_sezione per compat con il vincolo unico).
    const { data: section } = await supabase
      .from('sections')
      .select('id, name, scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    // Riga registro esistente per questo slot?
    const { data: esistente } = await supabase
      .from('registro_orario')
      .select('id')
      .eq('section_id', sectionId)
      .eq('data', data)
      .eq('ora_lezione', oraLezione)
      .maybeSingle()

    // Vincolo temporale: registro di classe = 'classe_orale' (default 2 giorni).
    const lock = await isOltreScadenza(supabase, section.scuola_id, data, 'classe_orale')
    if (lock.locked) {
      // Override solo se il dirigente ha sbloccato questa riga.
      let overridden = false
      if (esistente) {
        const { data: sblocco } = await supabase
          .from('sblocchi_audit')
          .select('id')
          .eq('entita_tipo', 'registro')
          .eq('entita_id', esistente.id)
          .limit(1)
          .maybeSingle()
        overridden = !!sblocco
      }
      if (!overridden) {
        return NextResponse.json(
          { error: `Registrazione bloccata: superato il termine di ${lock.giorniLimite} giorni. Richiedi lo sblocco al dirigente.`, locked: true },
          { status: 423 }
        )
      }
    }

    const isIndipendente = tipoCompresenza === 'sostegno' && Array.isArray(destinatariIds) && destinatariIds.length > 0

    // UPSERT della riga registro. I contenuti CONDIVISI (argomento/compiti) si
    // scrivono solo per firma principale/compresenza/cofirma, non per firma indipendente.
    const sharedFields = isIndipendente
      ? {}
      : {
          materia_id: materiaId ?? null,
          argomento: argomento || null,
          compiti: compiti || null,
          data_consegna_compiti: dataConsegnaCompiti || null,
        }

    const { data: registroRow, error: regErr } = await supabase
      .from('registro_orario')
      .upsert(
        {
          scuola_id: section.scuola_id,
          section_id: sectionId,
          classe_sezione: section.name,
          data,
          ora_lezione: oraLezione,
          da_orario: body.daOrario ?? false,
          ...sharedFields,
        },
        { onConflict: 'classe_sezione,data,ora_lezione' }
      )
      .select()
      .single()
    if (regErr) return NextResponse.json({ error: regErr.message }, { status: 500 })

    // UPSERT firma del docente.
    const { data: firmaRow, error: firmaErr } = await supabase
      .from('firme_docenti')
      .upsert(
        {
          registro_id: registroRow.id,
          maestra_id: firmaUserId,
          tipo_compresenza: tipoCompresenza,
          argomento_proprio: isIndipendente ? argomentoProprio || null : null,
          compiti_propri: isIndipendente ? compitiPropri || null : null,
        },
        { onConflict: 'registro_id,maestra_id' }
      )
      .select()
      .single()
    if (firmaErr) return NextResponse.json({ error: firmaErr.message }, { status: 500 })

    // Destinatari (oscuramento): sostituisce quelli della firma.
    if (isIndipendente && firmaRow) {
      await supabase.from('registro_destinatari').delete().eq('firma_id', firmaRow.id)
      const rows = destinatariIds.map((alunnoId: string) => ({
        registro_id: registroRow.id,
        firma_id: firmaRow.id,
        alunno_id: alunnoId,
      }))
      if (rows.length) await supabase.from('registro_destinatari').insert(rows)
    }

    // Notifica compiti (buffer). Destinatari: gli alunni indicati (firma
    // indipendente) oppure tutta la classe. Best-effort.
    try {
      if (compiti || compitiPropri) {
        let target: string[] = destinatariIds
        if (!isIndipendente) {
          const { data: classe } = await supabase.from('alunni').select('id').eq('section_id', sectionId)
          target = (classe ?? []).map((a) => a.id)
        }
        await enqueueNotifichePerAlunni(supabase, {
          alunnoIds: target,
          tipo: 'compiti',
          titolo: 'Nuovi compiti assegnati',
          corpo: (compiti || compitiPropri || '').slice(0, 140),
          link: '/parent/compiti',
          entitaTipo: 'registro',
          entitaId: registroRow.id,
        })
      }
    } catch { /* non bloccare il salvataggio */ }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'registro',
      entitaId: registroRow.id,
      azione: 'update',
      scuolaId: section.scuola_id,
      sectionId,
      valoreDopo: { registro: registroRow, firma: firmaRow },
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, scuolaId: section.scuola_id, area: 'registro', link: `/teacher/primaria/${sectionId}/registro` })

    return NextResponse.json({ success: true, data: { registro: registroRow, firma: firmaRow } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
