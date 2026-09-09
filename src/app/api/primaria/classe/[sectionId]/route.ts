import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
// ⚠️ `haRuolo` da `predicati-ruolo` e NON da `require-staff`: 296 file di test
// sostituiscono `require-staff` per intero — questa route compresa, riga sopra — e
// un predicato importato di là arriverebbe `undefined` sotto mock. Le due strade
// portano alla STESSA funzione (`require-staff` la ri-esporta), ma una sola
// sopravvive. Il perché per esteso sta nella testata di `predicati-ruolo.ts`.
import { haRuolo } from '@/lib/auth/predicati-ruolo'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { loadGradoContext } from '@/lib/auth/require-grado'
import { materieDiDocenteInSezione } from '@/lib/sezioni/docenti'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `sectionId` (param dinamico) è usato come UUID nelle query (sections.id,
// alunni.section_id, materie.section_id) → zUuid. `userId` in query è
// consumato dal gate identità (requireDocente), non dall'handler.

// GET /api/primaria/classe/[sectionId]?userId=
// Bundle di contesto classe: dati sezione, alunni, materie.
export const GET = withRoute('primaria/classe/[sectionId]:GET', async (
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) => {
  try {
    const { sectionId: rawSectionId } = await params

    // 1) Gate ruolo (educator/admin/coordinator/segreteria; genitore escluso).
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const secParsed = parseData(zUuid, rawSectionId)
    if ('response' in secParsed) return secParsed.response
    const sectionId = secParsed.data

    const supabase = await createAdminClient()

    // 2) Scope per plesso/classe (educator: solo sezioni assegnate; staff/segreteria: tutto il plesso).
    const scopeErr = await assertSezioneInScope(supabase, user, sectionId)
    if (scopeErr) return scopeErr

    // 3) Abilitazione al grado primaria: solo per il docente puro
    //    (admin/coordinator/segreteria bypassano — agiscono su tutta la scuola).
    //
    // ⚠️ `haRuolo` e non `user.role`: `require-staff.ts:341-348` (`conRuoloAttivo`)
    // scrive il cookie `kv-active-role` SOPRA `user.role` prima che la route veda
    // l'utente. Con la veste, la maestra che è anche mamma — entrata legittimamente,
    // perché `requireDocente` i ruoli REALI li guarda — saltava questo gate
    // interamente: non veniva tenuta fuori, veniva fatta entrare *come Segreteria*.
    //
    // ⚠️ CHI CONSOLIDA QUESTO BLOCCO IN `assertGradoDocente` (`require-grado.ts:145`)
    // LEGGA PRIMA LA RIGA 149 DI QUEL FILE: al 2026-09-09 il predicato condiviso
    // chiede `user.role !== 'educator'`, cioè di nuovo la VESTE, e adottarlo così
    // com'è rimette dentro esattamente il difetto corretto qui. Non è un'ipotesi:
    // è già collegato a `primaria/registro:POST:251`, che SCRIVE. La precondizione
    // per adottarlo è una riga — `if (!haRuolo(user, 'educator')) return null`.
    // `primaria-classe-ruolo-reale.test.ts` esegue il predicato VERO apposta per
    // dirlo: con la veste cadono i due casi in veste di genitore e restano verdi i
    // gemelli in veste da maestra; con `haRuolo` sono verdi tutti e dodici.
    if (haRuolo(user, 'educator')) {
      const ctx = await loadGradoContext(user.id)
      if (!ctx || !ctx.gradi.includes('primaria')) {
        return NextResponse.json({ error: 'Docente non abilitato alla primaria' }, { status: 403 })
      }
    }

    const [{ data: section }, { data: alunni }] = await Promise.all([
      supabase.from('sections').select('id, name, school_type, scuola_id').eq('id', sectionId).maybeSingle(),
      // Alunni attivi della sezione (fonte unica: alunni.section_id, sincronizzato dal trigger).
      supabase.from('alunni').select('id, nome, cognome, allergies, allergeni').eq('section_id', sectionId).eq('stato', 'iscritto').order('cognome'),
    ])
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    // Materie: il docente vede SOLO le proprie (contitolarità/isolamento disciplina);
    // staff/segreteria operano sull'intera classe → tutte le materie attive della sezione.
    //
    // ⚠️ Stessa ragione della riga 43, e qui l'effetto era il più grosso: con
    // `user.role` un docente-genitore in veste di genitore cadeva nel ramo `else` e
    // riceveva TUTTE le materie della sezione — quelle delle colleghe comprese.
    // L'isolamento dichiarato due righe sopra si apriva cambiando veste.
    let materie: unknown[] = []
    if (haRuolo(user, 'educator')) {
      const materieIds = await materieDiDocenteInSezione(supabase, user.id, sectionId)
      if (materieIds.length) {
        const { data } = await supabase
          .from('materie')
          .select('id, nome, codice, e_civica, turno_mensa')
          .in('id', materieIds)
          .eq('attiva', true)
          .order('ordine')
        materie = data ?? []
      }
    } else {
      const { data } = await supabase
        .from('materie')
        .select('id, nome, codice, e_civica, turno_mensa')
        .eq('section_id', sectionId)
        .eq('attiva', true)
        .order('ordine')
      materie = data ?? []
    }

    return NextResponse.json({
      success: true,
      data: { section, alunni: alunni ?? [], materie },
    })
  } catch (err) {
    logErrore({ operazione: 'primaria/classe/[sectionId]:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
