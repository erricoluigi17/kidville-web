import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireKitchenRead } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti'
import { sezioniDiNome } from '@/lib/sezioni/risoluzione'
import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  // stringa permissiva come nelle sorelle del modulo: '' ricade sul fallback
  scuola_id: z.string().optional(),
  classe: z.string().optional(),
})

interface AlunnoRow {
  id: string
  nome: string | null
  cognome: string | null
  classe_sezione: string | null
  section_id: string | null
}

interface TicketRow {
  alunno_id: string
  saldo_ticket: number | null
  ultimo_carico: string | null
}

/**
 * GET /api/mensa/ticket-residui?userId=&scuola_id=&classe=
 *
 * Quanti pasti restano a ogni bambino della sede, in ordine alfabetico.
 *
 * ⚠️ L'ELENCO PARTE DAGLI ALUNNI, NON DAI TICKET — e non è un dettaglio di
 * implementazione. Misurato in produzione il 2026-09-07: `ticket_mensa` ha **18
 * righe** contro **643 alunni iscritti** (Cesa 0, Aversa 0, Giugliano 1). Chi non
 * ha mai ricaricato NON HA la riga: interrogare `ticket_mensa` avrebbe mostrato 18
 * bambini su 643, e in due sedi su tre una schermata vuota indistinguibile da un
 * guasto. Niente riga ⇒ saldo 0, che è la verità: zero pasti disponibili.
 *
 * Due query separate invece di un embed PostgREST, di proposito: se `ticket_mensa`
 * non risponde (il DB E2E della CI è un progetto separato e non migrato) l'elenco
 * resta servito con i saldi a zero E il flag `saldi_non_disponibili`, così «tutti a
 * zero» non viene scambiato per un dato reale.
 *
 * Gate: `requireKitchenRead` (admin/coordinator/segreteria/cuoca/educator), la
 * stessa porta del report cucina. L'`educator` deve dichiarare la propria sezione
 * ed è confinato a quella, esattamente come in `mensa/report`.
 */
export const GET = withRoute('mensa/ticket-residui:GET', async (request: NextRequest) => {
  try {
    const auth = await requireKitchenRead(request)
    if (auth.response) return auth.response
    const { user } = auth

    const qp = parseQuery(request, getQuerySchema)
    if ('response' in qp) return qp.response
    const classe = qp.data.classe?.trim() || undefined

    const supabase = await createAdminClient()

    // L'insegnante vede SOLO la propria sezione: stessa regola (e stesso segnale
    // di sicurezza) di `mensa/report`, perché è la stessa domanda posta altrove.
    if (user.role === 'educator') {
      if (!classe) {
        return NextResponse.json({ error: 'Parametro classe obbligatorio per il ruolo insegnante', codice: 'MENSA_CLASSE_OBBLIGATORIA' }, { status: 400 })
      }
      const mie = await nomiSezioniDiUtente(supabase, user.id)
      if (!mie.includes(classe)) {
        // warn → persistito: solo uuid utente e nome sezione, nessun dato di minori.
        logEvento('mensa', 'warn', { tipo: 'classe-fuori-scope', utente: user.id, sezione: classe })
        return NextResponse.json({ error: 'Sezione non assegnata al docente', codice: 'MENSA_SEZIONE_NON_ASSEGNATA' }, { status: 403 })
      }
    }

    const sw = await resolveScuolaScrittura(request, supabase, user, qp.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    // ── 1) gli alunni iscritti della sede ────────────────────────────────────
    let q = supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, section_id')
      .eq('scuola_id', scuolaId)
      .eq('stato', 'iscritto')
      .limit(LIMITE_ELENCO_ALUNNI)
    if (classe) {
      // Per UUID, non per nome: `alunni.classe_sezione` può divergere da
      // `sections.name` (cinque classi di Giugliano, 2026-09-02). L'etichetta
      // mostrata resta `classe_sezione`; qui cambia solo CHI entra nell'elenco.
      const sezioni = await sezioniDiNome(supabase, classe, [scuolaId])
      q = q.in('section_id', sezioni)
    }
    const { data: alunniData, error: alunniErr } = await q
    if (alunniErr) {
      logErrore({ operazione: 'mensa/ticket-residui:GET', stato: 500 }, alunniErr)
      return NextResponse.json({ error: 'Errore nel caricamento degli alunni', codice: 'MENSA_ELENCO_NON_LETTO' }, { status: 500 })
    }
    const alunni = (alunniData ?? []) as AlunnoRow[]
    if (alunni.length === LIMITE_ELENCO_ALUNNI) {
      // Un elenco troncato non produce un errore: produce meno bambini e nessuno
      // che se ne accorga. Almeno lo si scrive nei log.
      logEvento('mensa', 'warn', { tipo: 'elenco-ticket-troncato', righe: alunni.length, limite: LIMITE_ELENCO_ALUNNI })
    }

    // ── 2) i saldi, per la sola sede (join !inner: nessun leak cross-plesso) ──
    // `ticket_mensa` non ha `scuola_id`: lo scoping passa da `alunni`, come in
    // `pagamenti/ticket/morosi`.
    const { data: ticketData, error: ticketErr } = await supabase
      .from('ticket_mensa')
      .select('alunno_id, saldo_ticket, ultimo_carico, alunni!inner ( scuola_id )')
      .eq('alunni.scuola_id', scuolaId)
    // PostgREST non lancia: senza questo ramo un guasto di lettura diventerebbe
    // «tutti a zero», che qui è una frase di senso compiuto e quindi la bugia
    // peggiore. Si degrada, ma lo si dichiara al chiamante e nei log.
    const saldiNonDisponibili = Boolean(ticketErr)
    if (ticketErr) {
      logEvento('db', 'error', {
        operazione: 'mensa/ticket-residui:GET',
        esito: 'saldi-ticket-non-letti',
        alunni: alunni.length,
      }, ticketErr)
    }

    const saldi = new Map<string, TicketRow>()
    for (const r of (ticketData ?? []) as TicketRow[]) saldi.set(r.alunno_id, r)

    const righe = alunni.map((a) => {
      const t = saldi.get(a.id)
      return {
        alunno_id: a.id,
        nome: a.nome ?? '',
        cognome: a.cognome ?? '',
        classe: a.classe_sezione ?? null,
        saldo_ticket: Number(t?.saldo_ticket ?? 0),
        ultimo_carico: t?.ultimo_carico ?? null,
      }
    })

    // Ordine alfabetico vero (it): «Àbate» prima di «Rossi», «rossi» accanto a
    // «Rossi». Un `.order()` di PostgREST ordina per byte e li separerebbe.
    righe.sort((x, y) =>
      x.cognome.localeCompare(y.cognome, 'it', { sensitivity: 'base' }) ||
      x.nome.localeCompare(y.nome, 'it', { sensitivity: 'base' }))

    const classi = Array.from(new Set(alunni.map((a) => a.classe_sezione).filter((c): c is string => Boolean(c))))
      .sort((a, b) => a.localeCompare(b, 'it'))

    return NextResponse.json({
      success: true,
      data: {
        classi,
        alunni: righe,
        totale_residui: righe.reduce((n, r) => n + r.saldo_ticket, 0),
        senza_ticket: righe.filter((r) => r.saldo_ticket <= 0).length,
        saldi_non_disponibili: saldiNonDisponibili,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'mensa/ticket-residui:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'MENSA_TICKET_NON_LETTI' }, { status: 500 })
  }
})
