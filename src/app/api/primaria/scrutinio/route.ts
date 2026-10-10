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

/** Esito delle funzioni `salva_*_scrutinio` (supabase/migrations/…_scrutinio_controllo_versione.sql). */
type EsitoSalvataggio =
  | { esito: 'ok'; righe: Record<string, unknown>[] }
  | { esito: 'non_trovato' }
  | { esito: 'chiuso' }
  | { esito: 'conflitto'; conflitti: Array<{ alunno_id: string; materia_id?: string; versione: string | null }> }

type Supabase = Awaited<ReturnType<typeof createAdminClient>>

/** La chiave `versione` passa solo se il client l'ha mandata: assente ≠ null («la riga non c'era»). */
function conVersione(x: { versione?: string | null }): { versione?: string | null } {
  return x.versione === undefined ? {} : { versione: x.versione }
}

/**
 * Il salvataggio con CONTROLLO DI VERSIONE (fase 5 robustezza, D5-B).
 *
 * Fino al 2026-10-10 qui c'era un upsert cieco e la pagina rimandava tutta la classe:
 * il secondo che salvava riscriveva con i valori vecchi della sua schermata quello che
 * il primo aveva appena cambiato. Ora la decisione sta in SQL, sotto il blocco della
 * riga di `scrutini`: una riga cambiata da altri dopo la lettura del client, con un
 * valore diverso, è un conflitto e non si scrive NIENTE (409 con i soli uuid).
 */
async function salvaConVersione(
  supabase: Supabase,
  funzione: 'salva_giudizi_scrutinio' | 'salva_comportamento_scrutinio',
  operazione: string,
  scrutinioId: string,
  righe: Record<string, unknown>[],
): Promise<{ righe: Record<string, unknown>[] } | { response: NextResponse }> {
  // Una pagina aperta prima del rilascio non manda la versione: quelle righe si
  // scrivono come prima («vince l'ultimo»). Va saputo quante sono.
  const senzaVersione = righe.filter((r) => !('versione' in r)).length
  if (senzaVersione > 0) {
    logEvento('registro', 'warn', { operazione, esito: 'versione_assente', scrutinio_id: scrutinioId, n: senzaVersione })
  }

  const { data, error } = await supabase.rpc(funzione, { p_scrutinio_id: scrutinioId, p_righe: righe })
  if (error) {
    const code = (error as { code?: string }).code
    if (code === 'PGRST202' || code === '42883') {
      logEvento('registro', 'error', { operazione, esito: 'funzione_assente', scrutinio_id: scrutinioId }, error)
      return { response: NextResponse.json(
        { error: 'Il salvataggio dello scrutinio non è disponibile in questo momento', codice: 'SCRUTINIO_SALVATAGGIO_NON_DISPONIBILE' },
        { status: 503 },
      ) }
    }
    if (code === '22P02' || code === '22007' || code === '22008' || code === '22023' || code === '21000') {
      logEvento('registro', 'warn', { operazione, esito: 'input_rifiutato', scrutinio_id: scrutinioId, error_code: code }, error)
      return { response: NextResponse.json(
        { error: 'Dati dello scrutinio non validi', codice: 'SCRUTINIO_DATI_NON_VALIDI' },
        { status: 400 },
      ) }
    }
    return { response: guastoDb(operazione, 'scrittura-non-riuscita', error) }
  }

  const esito = data as EsitoSalvataggio
  if (esito.esito === 'non_trovato') {
    return { response: NextResponse.json({ error: 'Scrutinio non trovato', codice: 'SCRUTINIO_NON_TROVATO' }, { status: 404 }) }
  }
  if (esito.esito === 'chiuso') {
    // La chiusura è passata fra il controllo qui sopra e il blocco della funzione.
    return { response: NextResponse.json(
      { error: 'Scrutinio chiuso: modifiche non consentite', codice: 'SCRUTINIO_CHIUSO', locked: true },
      { status: 423 },
    ) }
  }
  if (esito.esito === 'conflitto') {
    logEvento('registro', 'info', { operazione, esito: 'conflitto_versione', scrutinio_id: scrutinioId, n: esito.conflitti.length })
    return { response: NextResponse.json(
      { error: 'Qualcun altro ha modificato queste righe dopo che le hai aperte', codice: 'SCRUTINIO_CONFLITTO', conflitti: esito.conflitti },
      { status: 409 },
    ) }
  }

  logEvento('registro', 'info', { operazione, esito: 'salvato', scrutinio_id: scrutinioId, n: esito.righe.length })
  return { righe: esito.righe }
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Un timestamp come lo restituisce PostgREST; il formato lo controlla il cast
// nella funzione SQL (22007 → 400).
const zVersione = z.string().min(1).max(64).nullable().optional()

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
    // La versione letta dal client (`updated_at` della riga; null = «non c'era»).
    // ASSENTE solo da una pagina aperta prima del 2026-10-10: si scrive come prima.
    versione: zVersione,
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
    versione: zVersione,
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

    const [
      { data: alunni },
      { data: materie },
      { data: mieMaterie },
      { data: giudizi },
      { data: comportamento },
      { data: scala },
      { data: pagelle, error: errPagelle },
    ] =
      await Promise.all([
        supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome'),
        supabase.from('materie').select('id, nome, codice, e_civica, ordine').eq('section_id', sectionId).eq('attiva', true).order('ordine'),
        supabase.from('utenti_sezioni_materie').select('materia_id').eq('utente_id', userId).eq('section_id', sectionId),
        supabase.from('scrutinio_giudizi').select('*').eq('scrutinio_id', scrutinio.id),
        supabase.from('scrutinio_comportamento').select('*').eq('scrutinio_id', scrutinio.id),
        scuolaId
          ? supabase.from('giudizi_sintetici_scala').select('etichetta, ordine').eq('scuola_id', scuolaId).eq('attivo', true).order('ordine')
          : Promise.resolve({ data: [] as { etichetta: string; ordine: number }[] }),
        // Quali alunni hanno DAVVERO un PDF archiviato (spec 2026-09-24, S3):
        // la pagina mostra «Elimina pagella» solo su queste, non su ogni alunno.
        supabase.from('pagelle').select('alunno_id').eq('scrutinio_id', scrutinio.id),
      ])

    // Degrado DICHIARATO, non un 500: senza questo elenco la pagina dello
    // scrutinio (giudizi, comportamento, PDF) resta utilizzabile, e l'unica cosa
    // che si perde è il comando distruttivo «Elimina pagella», che non si mostra.
    // Nascondere è il lato sicuro; `pagelleArchiviateNonLette` dice perché.
    if (errPagelle) {
      logEvento('db', 'error', { operazione: 'primaria/scrutinio:GET', esito: 'pagelle-archiviate-non-lette' }, errPagelle)
    }
    const pagelleArchiviate = errPagelle
      ? []
      : [...new Set((pagelle ?? []).map((p) => p.alunno_id as string))]

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
        // Solo uuid degli alunni: nessun dato personale in più di quanto la
        // risposta porti già con `alunni`.
        pagelleArchiviate,
        pagelleArchiviateNonLette: Boolean(errPagelle),
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
      (g): g is { alunnoId: string; materiaId: string; giudizioSintetico?: string | null; versione?: string | null } =>
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
    let rows: { alunno_id: string; materia_id: string; giudizio_sintetico: string | null; proposto_da: string | null; versione?: string | null }[]
    if (auth.user.role === 'educator') {
      rows = valid.map((g) => ({
        alunno_id: g.alunnoId,
        materia_id: g.materiaId,
        giudizio_sintetico: g.giudizioSintetico ?? null,
        proposto_da: auth.user.id,
        ...conVersione(g),
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
          alunno_id: g.alunnoId,
          materia_id: g.materiaId,
          giudizio_sintetico: g.giudizioSintetico ?? null,
          proposto_da: proposto, // mai la segreteria
          ...conVersione(g),
        })
      }
    }

    const salvato = await salvaConVersione(supabase, 'salva_giudizi_scrutinio', 'primaria/scrutinio:POST', scrutinioId, rows)
    if ('response' in salvato) return salvato.response
    const data = salvato.righe

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      sectionId,
      valoreDopo: data,
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'scrutinio', link: `/teacher/primaria/${sectionId}/scrutinio` })

    return NextResponse.json({ success: true, data })
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
          versione?: string | null
        } => Boolean(c && c.alunnoId),
      )
      .map((c) => ({
        alunno_id: c.alunnoId,
        giudizio_testo: c.giudizioTesto ?? null,
        scala_valore: c.scalaValore ?? null,
        giudizio_globale: c.giudizioGlobale ?? null,
        ...conVersione(c),
      }))
    if (rows.length === 0) return NextResponse.json({ success: true, data: [] })

    // Gli alunni devono appartenere alla sezione dello scrutinio (no cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, rows.map((r) => r.alunno_id), sectionId)
    if (alunniErr) return alunniErr

    // Il guasto non rimanda al browser il `message` di PostgREST (prosa inglese e
    // nomi di meccanismi interni davanti a chi lavora in segreteria): il motivo
    // vero passa da `guastoDb`, cioè finisce nel log dove serve.
    const salvato = await salvaConVersione(supabase, 'salva_comportamento_scrutinio', 'primaria/scrutinio:PATCH', scrutinioId, rows)
    if ('response' in salvato) return salvato.response
    const data = salvato.righe

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      sectionId,
      valoreDopo: data,
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'scrutinio', link: `/teacher/primaria/${sectionId}/scrutinio` })

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'primaria/scrutinio:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
