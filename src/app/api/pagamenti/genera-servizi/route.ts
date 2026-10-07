import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { eDirezione } from '@/lib/auth/predicati-ruolo'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { sedeDellaGenerazione, generaServizi, funzioneAssente, rispostaServiziNonDisponibili } from '@/lib/pagamenti/generazione-server'
import { zMese, primoDelMese } from '@/lib/pagamenti/servizi-mensili'

/**
 * Generazione MANUALE dei servizi mensili (pomeridiano, doposcuola, pulmino…) di un mese:
 * l'anteprima (GET) e la conferma (POST). Gemella di `genera-rette`, che li genera anche
 * insieme alle rette. La sede è quella delle scritture (`sedeDellaGenerazione`) e per
 * l'anteprima è la STESSA della conferma: ciò che si conta è ciò che si scrive.
 */

// stringa vuota o null = assente: la sede la decide `sedeDellaGenerazione` (400 se ambigua)
const zScuolaId = z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional())

/**
 * Anno scolastico per intero, per l'anno d'INIZIO (2026 = 2026/27): settembre–giugno, gli stessi
 * mesi di `genera_servizi_anno`. Dalla query string arriva come testo, quindi si converte.
 */
const zAnnoInizio = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.number().int().min(2000).max(2100).optional(),
)

/** Serve ESATTAMENTE uno fra mese e anno: né entrambi (quale vale?) né nessuno. */
const unoFraMeseEAnno = {
  check: (b: { periodo?: string; anno?: number }) => (b.periodo !== undefined) !== (b.anno !== undefined),
  opzioni: { message: 'Indica il mese oppure l’anno scolastico, uno solo', path: ['periodo'] },
}

const getQuerySchema = z
  .object({ periodo: zMese.optional(), anno: zAnnoInizio, scuola_id: zScuolaId })
  .refine(unoFraMeseEAnno.check, unoFraMeseEAnno.opzioni)

const postBodySchema = z
  .object({ periodo: zMese.optional(), anno: z.number().int().min(2000).max(2100).optional(), scuola_id: zScuolaId })
  .refine(unoFraMeseEAnno.check, unoFraMeseEAnno.opzioni)

/** I periodi 'YYYY-MM-01' di un anno scolastico: set–dic dell'anno, gen–giu del successivo. */
function periodiDellAnno(anno: number): string[] {
  const due = (m: number) => String(m).padStart(2, '0')
  return [
    ...[9, 10, 11, 12].map((m) => `${anno}-${due(m)}-01`),
    ...[1, 2, 3, 4, 5, 6].map((m) => `${anno + 1}-${due(m)}-01`),
  ]
}

// GET /api/pagamenti/genera-servizi?periodo=YYYY-MM&scuola_id=  (staff)
// Anteprima: quante voci per servizio si genererebbero. Gli IMPORTI (totale e totali per
// servizio) sono della Direzione: per gli altri la chiave NON c'è, non è azzerata.
export const GET = withRoute('pagamenti/genera-servizi:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sede = await sedeDellaGenerazione(request, supabase, auth.user, 'pagamenti/genera-servizi:GET', q.data.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string
    const periodi = q.data.anno !== undefined ? periodiDellAnno(q.data.anno) : [primoDelMese(q.data.periodo as string)]
    // Il testo del log: il mese, o l'anno d'inizio.
    const quando = q.data.anno !== undefined ? { anno_inizio: q.data.anno } : { periodo: periodi[0] }

    // Una chiamata per mese, la stessa funzione dell'anteprima mensile; ogni errore si gestisce uguale.
    const raccolte: { categoria_id: string; importo: number | string | null }[] = []
    for (const periodo of periodi) {
      const { data, error } = await supabase.rpc('servizi_da_generare', {
        p_periodo: periodo,
        p_scuola_id: scuolaId,
        p_alunno_ids: null,
      })
      if (error) {
        const assente = funzioneAssente(error)
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/genera-servizi:GET',
          esito: assente ? 'servizi-non-disponibili' : 'anteprima-servizi-fallita',
          tipo: 'servizi_da_generare', scuola_id: scuolaId, periodo,
        }, error)
        return assente
          ? rispostaServiziNonDisponibili()
          : NextResponse.json(
              { error: 'Non è stato possibile calcolare l’anteprima dei servizi: riprova.', codice: 'SERVIZI_ANTEPRIMA_FALLITA' },
              { status: 500 },
            )
      }
      raccolte.push(...((data ?? []) as { categoria_id: string; importo: number | string | null }[]))
    }

    const voci = raccolte

    // I nomi dei servizi: una lettura sola sugli id restituiti. PostgREST non lancia.
    const ids = [...new Set(voci.map((v) => v.categoria_id))]
    const nomi = new Map<string, string>()
    if (ids.length > 0) {
      const { data: cat, error: errCat } = await supabase
        .from('payment_categories')
        .select('id, nome')
        .in('id', ids)
        // Il perimetro anche sui nomi: causali globali o della sede della generazione.
        .or(`scuola_id.is.null,scuola_id.eq.${scuolaId}`)
      if (errCat) {
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/genera-servizi:GET', esito: 'anteprima-servizi-fallita',
          tipo: 'nomi-categorie', scuola_id: scuolaId, ...quando,
        }, errCat)
        return NextResponse.json(
          { error: 'Non è stato possibile calcolare l’anteprima dei servizi: riprova.', codice: 'SERVIZI_ANTEPRIMA_FALLITA' },
          { status: 500 },
        )
      }
      for (const c of (cat ?? []) as { id: string; nome: string }[]) nomi.set(c.id, c.nome)
    }

    const direzione = eDirezione(auth.user)
    // Somme in centesimi: 7 × 33,33 in virgola mobile non dà 233,31 esatto.
    const somma = (xs: { importo: number | string | null }[]) =>
      Math.round(xs.reduce((s, v) => s + Number(v.importo ?? 0), 0) * 100) / 100
    const perServizio = ids.map((id) => {
      const sue = voci.filter((v) => v.categoria_id === id)
      return {
        categoria_id: id,
        nome: nomi.get(id) ?? null,
        voci: sue.length,
        ...(direzione ? { totale: somma(sue) } : {}),
      }
    })

    return NextResponse.json({
      success: true,
      data: {
        ...(q.data.anno !== undefined ? { anno_inizio: q.data.anno } : { periodo: periodi[0] }),
        voci: voci.length,
        per_servizio: perServizio,
        ...(direzione ? { totale: somma(voci) } : {}),
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera-servizi:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'SERVIZI_ANTEPRIMA_FALLITA' }, { status: 500 })
  }
})

// POST /api/pagamenti/genera-servizi  (staff) — conferma la generazione di un mese
// Body: { periodo: 'YYYY-MM' } oppure { anno: 2026 } (anno scolastico 2026/27), più scuola_id
export const POST = withRoute('pagamenti/genera-servizi:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const sede = await sedeDellaGenerazione(request, supabase, auth.user, 'pagamenti/genera-servizi:POST', b.data.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string
    const periodo = b.data.periodo !== undefined ? primoDelMese(b.data.periodo) : null

    // `generaServizi` logga già successo e guasto e scrive l'audit: qui non si duplica.
    const esito = await generaServizi(supabase, {
      ...(periodo !== null ? { periodo } : { anno: b.data.anno as number }),
      scuolaId, alunnoIds: null,
      utenteId: auth.user.id, operazione: 'pagamenti/genera-servizi:POST', azione: 'manuale',
    })
    if (!esito.ok) {
      return esito.codice === 'SERVIZI_NON_DISPONIBILI'
        ? rispostaServiziNonDisponibili()
        : NextResponse.json(
            { error: 'I servizi mensili non sono stati generati: riprova', codice: 'SERVIZI_NON_GENERATI' },
            { status: 500 },
          )
    }
    return NextResponse.json({
      success: true,
      data: periodo !== null ? { periodo, generati: esito.generati } : { anno_inizio: b.data.anno, generati: esito.generati },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera-servizi:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'SERVIZI_NON_GENERATI' }, { status: 500 })
  }
})
