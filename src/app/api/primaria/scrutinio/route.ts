import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { titolareDiMateria } from '@/lib/audit/valutatore'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * Il guasto del DATABASE di questa route, distinto dai suoi rifiuti.
 *
 * PostgREST non lancia: un `const { data } = await supabase.from(…)` che non
 * controlla l'`error` non ottiene «errore», ottiene `null` — e qui sotto `null`
 * diventa `?? []`, cioè un INSIEME VUOTO usato per decidere. Nel POST i tre punti
 * in cui questo cambiava la decisione, e non solo la schermata:
 *
 *  1. `materie` della sezione — insieme vuoto ⇒ `materiaIds.some(id => !materieOk.has(id))`
 *     è vero ⇒ **403 «Materia non appartenente alla sezione»**. Al docente si dice
 *     che sta scrivendo sulla classe di qualcun altro perché una query è caduta.
 *  2. `utenti_sezioni_materie` (le materie del docente) — insieme vuoto ⇒
 *     **403 «Materia non assegnata al docente»**, cioè «non sei tu il titolare»,
 *     detto a chi lo è.
 *  3. `scrutinio_giudizi` già proposti — mappa vuota ⇒ ogni giudizio sembra
 *     NUOVO ⇒ `proposto_da` viene ricalcolato al titolare (o a `null`) e
 *     RISCRITTO. È il «vero valutatore» del vincolo FEA, cioè chi firma il
 *     giudizio: il ramo staff esiste apposta per preservarlo, e una lettura
 *     caduta lo cancellava su tutta la classe in un salvataggio solo.
 *
 * Una funzione sola perché il lock `__tests__/architecture/errori-con-codice.test.ts`
 * conta le risposte d'errore senza `codice`: questa assorbe le due che c'erano già
 * sugli upsert del POST e del PATCH, che rimandavano al browser il `message` di
 * PostgREST. Il motivo vero resta nel log.
 *
 * ⚠️ Il file misura ora DODICI risposte senza codice e l'allowlist ne dichiara ancora
 * TREDICI: il lock è verde (fallisce solo se crescono), ma quella riga di scarto è
 * spazio in cui il debito può ricrescere senza che nessuno se ne accorga. Va chiusa
 * portando la voce a 12 e `totale_occorrenze` da 1429 a 1428 in
 * `docs/superpowers/errori-senza-codice-allowlist.json` — un file condiviso con gli
 * altri lotti, e per questo non toccato qui: è segnalato nel rapporto.
 */
function guastoDb(operazione: string, esito: string, error: unknown): NextResponse {
  logEvento('db', 'error', { operazione, esito }, error)
  return NextResponse.json({ error: 'Operazione sullo scrutinio non riuscita' }, { status: 500 })
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// periodoId assente o '' → lista periodi configurati (come oggi: '' è falsy).
const getQuerySchema = z.object({
  sectionId: zUuid,
  periodoId: zUuid.or(z.literal('')).optional(),
})

// Le voci di giudizi[]/comportamento[] prive di alunnoId (o materiaId) sono
// scartate in silenzio dal filtro dell'handler, come oggi: gli id restano
// quindi opzionali ('' compreso) e le voci possono essere null.
const giudizioItemSchema = z
  .object({
    alunnoId: zUuid.or(z.literal('')).nullish(),
    materiaId: zUuid.or(z.literal('')).nullish(),
    giudizioSintetico: z.string().nullish(),
  })
  .nullable()
const postBodySchema = z.object({
  scrutinioId: zUuid,
  giudizi: z.array(giudizioItemSchema),
})

const comportamentoItemSchema = z
  .object({
    alunnoId: zUuid.or(z.literal('')).nullish(),
    giudizioTesto: z.string().nullish(),
    scalaValore: z.string().nullish(),
    giudizioGlobale: z.string().nullish(),
  })
  .nullable()
const patchBodySchema = z.object({
  scrutinioId: zUuid,
  comportamento: z.array(comportamentoItemSchema),
})

// GET /api/primaria/scrutinio?sectionId=&periodoId=&userId=
// Apre (o recupera) lo scrutinio della classe per il periodo. Ritorna alunni,
// materie della sezione, le materie del docente (modificabili), i giudizi
// proposti, il comportamento e la scala dei 6 giudizi ufficiali.
export const GET = withRoute('primaria/scrutinio:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, periodoId } = q.data

    const supabase = await createAdminClient()

    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // Sezione + scuola (per la scala giudizi).
    const { data: sezione } = await supabase
      .from('sections')
      .select('id, name, school_type, scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    const scuolaId = sezione?.scuola_id ?? null

    // Senza periodoId: restituisci la lista dei periodi configurati (per il selettore).
    if (!periodoId) {
      const { data: periodi } = scuolaId
        ? await supabase
            .from('scrutinio_periodi')
            .select('id, nome, anno_scolastico, ordine, attivo')
            .eq('scuola_id', scuolaId)
            .eq('attivo', true)
            .order('ordine')
        : { data: [] as { id: string; nome: string }[] }
      return NextResponse.json({ success: true, data: { periodi: periodi ?? [] } })
    }

    // Il periodo deve appartenere alla scuola della sezione asserita: il GET crea
    // la riga scrutini(section, periodo), mai con un periodo di un altro tenant.
    const { data: periodo } = await supabase
      .from('scrutinio_periodi')
      .select('id')
      .eq('id', periodoId)
      .eq('scuola_id', scuolaId)
      .maybeSingle()
    if (!periodo) {
      return NextResponse.json({ error: 'Periodo non valido per questa scuola' }, { status: 403 })
    }

    // Scrutinio: crea se non esiste (idempotente via UNIQUE section+periodo).
    let { data: scrutinio } = await supabase
      .from('scrutini')
      .select('*')
      .eq('section_id', sectionId)
      .eq('periodo_id', periodoId)
      .maybeSingle()
    if (!scrutinio) {
      const { data: created, error: cErr } = await supabase
        .from('scrutini')
        .insert({ section_id: sectionId, periodo_id: periodoId })
        .select()
        .single()
      if (cErr) {
        // Race: rileggi.
        const { data: again } = await supabase
          .from('scrutini').select('*').eq('section_id', sectionId).eq('periodo_id', periodoId).maybeSingle()
        scrutinio = again
      } else {
        scrutinio = created
      }
    }
    if (!scrutinio) return NextResponse.json({ error: 'Impossibile aprire lo scrutinio' }, { status: 500 })

    const [{ data: alunni }, { data: materie }, { data: mieMaterie }, { data: giudizi }, { data: comportamento }, { data: scala }] =
      await Promise.all([
        supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome'),
        supabase.from('materie').select('id, nome, codice, e_civica, ordine').eq('section_id', sectionId).eq('attiva', true).order('ordine'),
        supabase.from('utenti_sezioni_materie').select('materia_id').eq('utente_id', userId).eq('section_id', sectionId),
        supabase.from('scrutinio_giudizi').select('*').eq('scrutinio_id', scrutinio.id),
        supabase.from('scrutinio_comportamento').select('*').eq('scrutinio_id', scrutinio.id),
        scuolaId
          ? supabase.from('giudizi_sintetici_scala').select('etichetta, ordine').eq('scuola_id', scuolaId).eq('attivo', true).order('ordine')
          : Promise.resolve({ data: [] as { etichetta: string; ordine: number }[] }),
      ])

    // Materie modificabili: l'educator solo le proprie (contitolarità); staff/segreteria
    // possono intervenire su tutte le materie della sezione (agiscono per l'intera classe).
    const mieMaterieIds = auth.user.role === 'educator'
      ? (mieMaterie ?? []).map((m) => m.materia_id)
      : (materie ?? []).map((m) => m.id)

    return NextResponse.json({
      success: true,
      data: {
        scrutinio,
        alunni: alunni ?? [],
        materie: materie ?? [],
        mieMaterieIds,
        giudizi: giudizi ?? [],
        comportamento: comportamento ?? [],
        scala: (scala ?? []).map((g) => g.etichetta),
      },
    })
  } catch (err) {
    logErrore({ operazione: 'primaria/scrutinio:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/scrutinio?userId=
// Proposta giudizi sintetici del docente per le proprie discipline.
// body: { scrutinioId, giudizi: [{ alunnoId, materiaId, giudizioSintetico }] }
export const POST = withRoute('primaria/scrutinio:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId, giudizi } = b.data

    const supabase = await createAdminClient()

    // Scrutinio + sezione (per scope + risoluzione titolare).
    const { data: scr } = await supabase.from('scrutini').select('id, stato, section_id').eq('id', scrutinioId).maybeSingle()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scr.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: modifiche non consentite', locked: true }, { status: 423 })

    const sectionId = scr.section_id as string
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const valid = giudizi.filter(
      (g): g is { alunnoId: string; materiaId: string; giudizioSintetico?: string | null } =>
        Boolean(g && g.alunnoId && g.materiaId),
    )
    if (valid.length === 0) return NextResponse.json({ success: true, data: [] })

    // Alunni e materie dei giudizi devono appartenere alla sezione dello scrutinio.
    const alunniErr = await assertAlunniInSezione(supabase, valid.map((g) => g.alunnoId), sectionId)
    if (alunniErr) return alunniErr
    const materiaIds = [...new Set(valid.map((g) => g.materiaId))]
    const { data: materieSez, error: errMaterieSez } = await supabase
      .from('materie')
      .select('id')
      .eq('section_id', sectionId)
      .in('id', materiaIds)
    // Senza questo ramo il catalogo non letto diventa «nessuna di queste materie
    // è della sezione», cioè un 403 al posto di un 500.
    if (errMaterieSez) return guastoDb('primaria/scrutinio:POST', 'materie-sezione-non-lette', errMaterieSez)
    const materieOk = new Set((materieSez ?? []).map((m) => m.id as string))
    if (materiaIds.some((id) => !materieOk.has(id))) {
      return NextResponse.json({ error: 'Materia non appartenente alla sezione' }, { status: 403 })
    }
    // L'educator propone solo per le proprie discipline (contitolarità server-side,
    // stesso criterio di mieMaterieIds nel GET). Staff/segreteria: tutte le materie.
    if (auth.user.role === 'educator') {
      const { data: mie, error: errMie } = await supabase
        .from('utenti_sezioni_materie')
        .select('materia_id')
        .eq('utente_id', auth.user.id)
        .eq('section_id', sectionId)
      // Le assegnazioni non lette non sono «nessuna assegnazione»: negare qui
      // vuol dire dire a un titolare che non è titolare della propria materia.
      if (errMie) return guastoDb('primaria/scrutinio:POST', 'assegnazioni-docente-non-lette', errMie)
      const mieSet = new Set((mie ?? []).map((m) => m.materia_id as string))
      if (materiaIds.some((id) => !mieSet.has(id))) {
        return NextResponse.json({ error: 'Materia non assegnata al docente' }, { status: 403 })
      }
    }

    // proposto_da = "vero valutatore" (vincolo FEA): MAI la segreteria.
    //  - educator → sé stesso;
    //  - staff/segreteria → preserva il proponente esistente; per i giudizi nuovi
    //    risolve il docente titolare della materia (null se nessuno). Mai l'attore staff.
    let rows: { scrutinio_id: string; alunno_id: string; materia_id: string; giudizio_sintetico: string | null; proposto_da: string | null }[]
    if (auth.user.role === 'educator') {
      rows = valid.map((g) => ({
        scrutinio_id: scrutinioId,
        alunno_id: g.alunnoId,
        materia_id: g.materiaId,
        giudizio_sintetico: g.giudizioSintetico ?? null,
        proposto_da: auth.user.id,
      }))
    } else {
      const { data: esistenti, error: errEsistenti } = await supabase
        .from('scrutinio_giudizi')
        .select('alunno_id, materia_id, proposto_da')
        .eq('scrutinio_id', scrutinioId)
      // Questa lettura È la conservazione di `proposto_da`. Se non arriva, il
      // ramo qui sotto non «preserva il proponente esistente» come dice il
      // commento: lo sostituisce. Meglio non salvare che salvare firmando al
      // posto di un altro.
      if (errEsistenti) return guastoDb('primaria/scrutinio:POST', 'proponenti-esistenti-non-letti', errEsistenti)
      const propByKey = new Map<string, string | null>(
        (esistenti ?? []).map((e) => [`${e.alunno_id}:${e.materia_id}`, (e.proposto_da as string | null) ?? null]),
      )
      const titolareCache = new Map<string, string | null>()
      rows = []
      for (const g of valid) {
        const key = `${g.alunnoId}:${g.materiaId}`
        let proposto = propByKey.get(key) ?? null
        if (!proposto) {
          if (!titolareCache.has(g.materiaId)) {
            titolareCache.set(g.materiaId, await titolareDiMateria(supabase, sectionId, g.materiaId))
          }
          proposto = titolareCache.get(g.materiaId) ?? null
        }
        rows.push({
          scrutinio_id: scrutinioId,
          alunno_id: g.alunnoId,
          materia_id: g.materiaId,
          giudizio_sintetico: g.giudizioSintetico ?? null,
          proposto_da: proposto, // mai la segreteria
        })
      }
    }

    const { data, error } = await supabase
      .from('scrutinio_giudizi')
      .upsert(rows, { onConflict: 'scrutinio_id,alunno_id,materia_id' })
      .select()
    if (error) return guastoDb('primaria/scrutinio:POST', 'giudizi-non-scritti', error)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      sectionId,
      valoreDopo: data ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'scrutinio', link: `/teacher/primaria/${sectionId}/scrutinio` })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/scrutinio:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/primaria/scrutinio?userId=
// Comportamento + giudizio globale per alunno.
// body: { scrutinioId, comportamento: [{ alunnoId, giudizioTesto?, scalaValore?, giudizioGlobale? }] }
export const PATCH = withRoute('primaria/scrutinio:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId, comportamento } = b.data

    const supabase = await createAdminClient()
    const { data: scr } = await supabase.from('scrutini').select('id, stato, section_id').eq('id', scrutinioId).maybeSingle()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scr.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio chiuso: modifiche non consentite', locked: true }, { status: 423 })

    const sectionId = scr.section_id as string
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const rows = comportamento
      .filter(
        (c): c is {
          alunnoId: string
          giudizioTesto?: string | null
          scalaValore?: string | null
          giudizioGlobale?: string | null
        } => Boolean(c && c.alunnoId),
      )
      .map((c) => ({
        scrutinio_id: scrutinioId,
        alunno_id: c.alunnoId,
        giudizio_testo: c.giudizioTesto ?? null,
        scala_valore: c.scalaValore ?? null,
        giudizio_globale: c.giudizioGlobale ?? null,
      }))
    if (rows.length === 0) return NextResponse.json({ success: true, data: [] })

    // Gli alunni devono appartenere alla sezione dello scrutinio (no cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, rows.map((r) => r.alunno_id), sectionId)
    if (alunniErr) return alunniErr

    const { data, error } = await supabase
      .from('scrutinio_comportamento')
      .upsert(rows, { onConflict: 'scrutinio_id,alunno_id' })
      .select()
    // Gemello dell'upsert del POST, e fino a qui era rimasto l'unico punto del
    // file che rimandava al browser il `message` di PostgREST: prosa inglese e
    // nomi di meccanismi interni davanti a chi lavora in segreteria. Il motivo
    // vero passa da `guastoDb`, cioè finisce nel log dove serve.
    if (error) return guastoDb('primaria/scrutinio:PATCH', 'comportamento-non-scritto', error)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      sectionId,
      valoreDopo: data ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'scrutinio', link: `/teacher/primaria/${sectionId}/scrutinio` })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/scrutinio:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
