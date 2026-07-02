import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria?studentId=&userId=
// Vista genitore (read-only) del registro primaria del figlio, con OSCURAMENTO:
// gli argomenti/compiti "propri" del docente di sostegno sono visibili solo se il
// figlio è tra i destinatari. Valutazioni mostrate dopo il buffer notifica.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const studentId = sp.get('studentId')
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, cognome, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Tipo scuola della sezione (per la vista adattiva lato client).
    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).maybeSingle()
      schoolType = sez?.school_type ?? null
    }

    if (schoolType !== 'primaria') {
      return NextResponse.json({ success: true, data: { schoolType, child: alunno, lezioni: [], valutazioni: [], note: [], assenze: [], materie: [] } })
    }

    // Buffer notifica (per la visibilità delle valutazioni).
    const { data: settings } = await supabase
      .from('admin_settings')
      .select('notif_buffer_valutazioni_min')
      .eq('scuola_id', alunno.scuola_id)
      .maybeSingle()
    const bufferMin = settings?.notif_buffer_valutazioni_min ?? 10
    const sogliaVal = new Date(Date.now() - bufferMin * 60_000).toISOString()

    // Ultimi 14 giorni di registro per la sezione.
    const da = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)

    const [{ data: registro }, { data: valutazioni }, { data: note }, { data: assenze }, { data: materie }] = await Promise.all([
      supabase
        .from('registro_orario')
        .select(`
          id, data, ora_lezione, materia, argomento, compiti, data_consegna_compiti,
          materie(nome),
          firme_docenti(id, argomento_proprio, compiti_propri),
          registro_destinatari(firma_id, alunno_id),
          allegati_registro(id, tipo, file_url, file_name)
        `)
        .eq('section_id', alunno.section_id)
        .gte('data', da)
        .order('data', { ascending: false })
        .order('ora_lezione'),
      supabase
        .from('valutazioni')
        .select('id, materia, tipo, modalita, argomento, giudizio_sintetico, giudizio_testo, creato_il')
        .eq('alunno_id', studentId)
        .not('modalita', 'is', null)
        .lte('creato_il', sogliaVal)
        .order('creato_il', { ascending: false }),
      supabase
        .from('note_disciplinari')
        .select('id, categoria, testo, richiede_firma, firmata_il, creato_il')
        .eq('alunno_id', studentId)
        .order('creato_il', { ascending: false }),
      // Assenze/ritardi/uscite degli ultimi 30 giorni, con stato giustificazione.
      supabase
        .from('presenze')
        .select('id, data, stato, giustificata, giustificazione_testo, giust_vista_il')
        .eq('alunno_id', studentId)
        .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
        .gte('data', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
        .order('data', { ascending: false }),
      // Materie della sezione (per il selettore della giustifica didattica).
      supabase
        .from('materie')
        .select('id, nome')
        .eq('section_id', alunno.section_id)
        .eq('attiva', true)
        .order('ordine'),
    ])

    // Applica oscuramento: contenuti "propri" visibili solo se il figlio è destinatario.
    const lezioni = (registro ?? []).map((r) => {
      const firme = (r.firme_docenti ?? []) as { id: string; argomento_proprio: string | null; compiti_propri: string | null }[]
      const dest = (r.registro_destinatari ?? []) as { firma_id: string; alunno_id: string }[]
      const extra = firme
        .filter((f) => (f.argomento_proprio || f.compiti_propri) && dest.some((d) => d.firma_id === f.id && d.alunno_id === studentId))
        .map((f) => ({ argomento: f.argomento_proprio, compiti: f.compiti_propri }))
      return {
        id: r.id,
        data: r.data,
        ora_lezione: r.ora_lezione,
        materia: (r.materie as { nome?: string } | null)?.nome ?? r.materia,
        argomento: r.argomento,
        compiti: r.compiti,
        data_consegna_compiti: r.data_consegna_compiti,
        allegati: r.allegati_registro ?? [],
        individualizzate: extra,
      }
    })

    return NextResponse.json({
      success: true,
      data: { schoolType, child: alunno, lezioni, valutazioni: valutazioni ?? [], note: note ?? [], assenze: assenze ?? [], materie: materie ?? [] },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
