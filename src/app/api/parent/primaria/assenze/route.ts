import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi produce lista vuota
// dalla query su `presenze` — stesso criterio di parent/competenze.
// `limit`: parseInt storico preservato nell'handler (default 60, nessun clamp):
// NON zPaginazione, che cambierebbe default e limiti.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
  limit: z.string().optional(),
})

// Stati contati nel riepilogo. `presente` INCLUSO di proposito: senza, un bambino
// presente resta indistinguibile da un appello non ancora fatto (falla del collaudo).
const STATI_RIEPILOGO = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const
type StatoRiepilogo = (typeof STATI_RIEPILOGO)[number]

// GET /api/parent/primaria/assenze?studentId=&userId=&limit=30
// Restituisce:
//  - `data`: la cronologia dettagliata dei SOLI stati negativi (assenze, ritardi,
//    uscite anticipate) — quelli su cui il genitore può agire (giustifica);
//  - `riepilogo`: i conteggi per stato (incluso `presente`) calcolati con COUNT
//    aggregato lato DB, SENZA scaricare i ~180 giorni di presenza dell'anno.
export const GET = withRoute('parent/primaria/assenze:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data
    const limit = parseInt(q.data.limit ?? '60', 10)

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    // ═══ SI CONTA CIÒ CHE È GIÀ ACCADUTO ═════════════════════════════════════
    //
    // Il contatore «Assenze» della pagina genitore passava da 1 a 2 nel momento
    // in cui si comunicava un'assenza per il 31/12/2099, e la riga compariva
    // nella cronologia: il bambino risultava assente per un giorno che non è
    // ancora arrivato.
    //
    // NON È UN ERRORE DI CALCOLO, è un'assunzione infranta. Fino al 2026-08-07
    // `presenze` aveva UNA sola sorgente di scrittura — il docente, sul giorno
    // corrente — quindi «una riga di presenze è un giorno già trascorso» era vero
    // per costruzione, e tutti i consumatori sono stati scritti su quel
    // presupposto. «Comunica un'assenza» ne introduce una seconda che scrive
    // `data >= oggi`. Un solo consumatore era stato adeguato
    // (`parent/presenze:GET`, che usa `.lte('data', oggi)` sul riepilogo): questo
    // no, ed è quello che alimenta il contatore che il genitore vede.
    //
    // ─── PERCHÉ `.lte` E NON `.lt`: OGGI CONTA ──────────────────────────────
    //
    // Due ragioni che tirano dalla stessa parte. (1) È la definizione già scelta
    // dalla route sorella per il riepilogo dei 30 giorni: due idee diverse di
    // «trascorso» dentro la stessa app si contraddirebbero proprio nelle due
    // schermate che le mostrano vicine. (2) Con `.lt`, l'appello che la maestra
    // fa stamattina resterebbe invisibile al genitore fino a domani — si
    // toglierebbe un dato VERO per nascondere un dato futuro.
    //
    // «Oggi» è quello ITALIANO (`oggiFiscaleISO`, `Europe/Rome`): il runtime gira
    // in UTC, e fra mezzanotte e le due del mattino `new Date().toISOString()`
    // restituisce ancora ieri.
    const oggi = oggiFiscaleISO()

    // Lista dettagliata dei soli stati negativi.
    const { data: presenze, error: presenzeErr } = await supabase
      .from('presenze')
      .select('id, data, stato, orario_entrata, orario_uscita, giustificata, giustificazione_testo, giustificata_il, note_appello')
      .eq('alunno_id', studentId)
      .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
      .lte('data', oggi)
      .order('data', { ascending: false })
      .limit(limit)

    if (presenzeErr) {
      // PostgREST non lancia: senza questo controllo una lettura fallita usciva
      // come `data: []` dentro un 200 valido — «non hai assenze» detto a chi ne
      // ha, e il ramo d'errore della schermata non veniva MAI raggiunto perché
      // la risposta era formalmente buona.
      logEvento('registro', 'error', {
        operazione: 'parent/primaria/assenze:GET',
        esito: 'assenze-non-lette',
        alunno_id: studentId,
      }, presenzeErr)
    }

    // Riepilogo: una query di conteggio per stato (`head: true` → nessuna riga
    // scaricata, solo il COUNT). PostgREST non lancia: su tabella/colonna assente
    // (E2E CI non migrato) `error` è valorizzato e `count` è null → il conteggio
    // degrada pulito a 0, e la risposta resta 200.
    const conteggi = await Promise.all(
      STATI_RIEPILOGO.map((stato) =>
        supabase
          .from('presenze')
          .select('id', { count: 'exact', head: true })
          .eq('alunno_id', studentId)
          .eq('stato', stato)
          .lte('data', oggi),
      ),
    )
    const riepilogo = STATI_RIEPILOGO.reduce((acc, stato, i) => {
      acc[stato] = conteggi[i]?.count ?? 0
      return acc
    }, {} as Record<StatoRiepilogo, number>)

    return NextResponse.json({ success: true, data: presenze ?? [], riepilogo })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/assenze:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
