import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { dataRomaDi } from '@/lib/primaria/timelock'
import {
  leggiBufferVisibilita,
  sogliaVisibilita,
  visibileAlGenitore,
  type ImpreparatoGenitore,
} from '@/lib/primaria/visibilita-genitore'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi degrada a 404 dalla
// query su `alunni` — stesso criterio di parent/competenze.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

const OPERAZIONE = 'parent/primaria/valutazioni:GET'

/** Colonna sconosciuta allo schema: il DB E2E della CI non ha `tipo` (non migrato). */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

function rispostaLetturaFallita(): NextResponse {
  return NextResponse.json({ error: 'Lettura non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
}

interface RigaImpreparato {
  id: string
  materia_id: string | null
  tipo?: string | null
  motivo: string | null
  data: string
  origine: string
  creato_da: string | null
  creato_il: string | null
  materie?: { nome?: string | null } | { nome?: string | null }[] | null
}

function nomeMateria(r: RigaImpreparato): string | null {
  const m = Array.isArray(r.materie) ? r.materie[0] : r.materie
  return m?.nome ?? null
}

// GET /api/parent/primaria/valutazioni?studentId=&userId=
// Valutazioni in itinere del figlio, raggruppate per materia, più gli impreparati.
// NB: nessuna media numerica nella risposta. La media (associazione numerica
// nascosta dei giudizi) è strumento di lavoro del docente e NON va MAI esposta
// al genitore — O.M. 3/2025, PRD §4 (#1/#3) e §4.5.
// Visibilità A TEMPO: il genitore vede una valutazione solo trascorso il buffer
// (notif_buffer_valutazioni_min, default 10') dalla creazione (PRD §4.5).
export const GET = withRoute('parent/primaria/valutazioni:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, alunnoErr)
      return rispostaLetturaFallita()
    }
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Buffer visibilità — una funzione sola per valutazioni e impreparati.
    const bufferMin = await leggiBufferVisibilita(supabase, (alunno.scuola_id as string | null) ?? null, OPERAZIONE)
    const soglia = sogliaVisibilita(bufferMin)

    const [
      { data: valutazioni, error: valutazioniErr },
      { data: materie, error: materieErr },
    ] = await Promise.all([
      supabase
        .from('valutazioni')
        .select('id, materia_id, tipo, modalita, giudizio_sintetico, giudizio_testo, creato_il, argomento')
        .eq('alunno_id', studentId)
        // Buffer a tempo: visibile solo se creata da più di `bufferMin`, così il
        // docente ha la finestra di correzione. Nessun filtro `pubblicato`: per le
        // valutazioni in itinere non viene mai impostato a true (PRD §4.5).
        .lte('creato_il', soglia)
        .order('creato_il', { ascending: false }),
      supabase
        .from('materie')
        .select('id, nome')
        .eq('section_id', alunno.section_id)
        .eq('attiva', true)
        .order('ordine'),
    ])
    // PostgREST non lancia: una lettura fallita tornava `data: []` con 200, e il
    // genitore leggeva «nessun voto» — uno stato che finge il successo.
    const letturaErr = valutazioniErr ?? materieErr
    if (letturaErr) {
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, letturaErr)
      return rispostaLetturaFallita()
    }

    // Gli impreparati del figlio, di ENTRAMBI i tipi (spec 2026-09-24, «2 Primaria»).
    // Quelli segnati dal docente li vede solo dopo il buffer — la stessa regola e la
    // stessa funzione delle valutazioni; quelli dichiarati dal genitore li vede subito.
    const colonne = 'id, materia_id, motivo, data, origine, creato_da, creato_il, materie(nome)'
    let impreparatiLetti: { data: unknown; error: { code?: string } | null } = await supabase
      .from('giustifiche_didattiche')
      .select(`${colonne}, tipo`)
      .eq('alunno_id', studentId)
      .order('data', { ascending: false })
    if (impreparatiLetti.error && COLONNA_ASSENTE.has(impreparatiLetti.error.code ?? '')) {
      // DB non migrato (E2E della CI): senza `tipo` il tipo si ricava dall'origine,
      // che è la regola del riempimento della migrazione.
      logEvento('registro', 'info', { operazione: OPERAZIONE, esito: 'tipo-non-disponibile-schema' }, impreparatiLetti.error)
      impreparatiLetti = await supabase
        .from('giustifiche_didattiche')
        .select(colonne)
        .eq('alunno_id', studentId)
        .order('data', { ascending: false })
    }
    if (impreparatiLetti.error) {
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, impreparatiLetti.error)
      return rispostaLetturaFallita()
    }
    const righeImpreparati = ((impreparatiLetti.data ?? []) as unknown as RigaImpreparato[]).filter(
      (r) => r.origine === 'genitore' || visibileAlGenitore(r.creato_il, soglia),
    )

    // Raggruppa per materia. Nessuna media: è riservata al docente (vedi nota in testa).
    const perMateria = new Map<string, { valutazioni: unknown[] }>()
    for (const v of valutazioni ?? []) {
      const entry = perMateria.get(v.materia_id) ?? { valutazioni: [] }
      entry.valutazioni.push(v)
      perMateria.set(v.materia_id, entry)
    }

    const data = (materie ?? [])
      .filter((m) => perMateria.has(m.id))
      .map((m) => {
        const entry = perMateria.get(m.id)!
        return {
          materiaId: m.id,
          nome: m.nome,
          valutazioni: entry.valutazioni,
        }
      })

    // Il genitore modifica o annulla la SUA dichiarazione fino al giorno
    // dichiarato compreso, in data di Roma — la stessa regola di PATCH/DELETE.
    const oggi = dataRomaDi(new Date())
    const impreparati: ImpreparatoGenitore[] = righeImpreparati.map((r) => {
      const origine = r.origine === 'genitore' ? 'genitore' : 'docente'
      const tipo =
        origine === 'genitore'
          ? 'giustificato'
          : r.tipo === 'giustificato'
            ? 'giustificato'
            : 'impreparato'
      return {
        id: r.id,
        tipo,
        motivo: r.motivo ?? null,
        materiaId: r.materia_id ?? null,
        materiaNome: nomeMateria(r),
        data: String(r.data).slice(0, 10),
        origine,
        creato_il: r.creato_il ?? null,
        modificabile_dal_genitore:
          origine === 'genitore' && r.creato_da === auth.user.id && String(r.data).slice(0, 10) >= oggi,
      }
    })

    // Le materie ATTIVE della classe, anche quelle ancora senza voti: servono al
    // modulo «Dichiara impreparato» della pagina Voti (compito G2), che senza
    // offrirebbe solo le materie già valutate. Lettura già fatta qui sopra.
    const materieClasse = (materie ?? []).map((m) => ({ id: m.id, nome: m.nome }))

    return NextResponse.json({ success: true, data, impreparati, materieClasse })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return rispostaLetturaFallita()
  }
})
