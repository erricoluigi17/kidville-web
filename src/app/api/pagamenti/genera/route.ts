import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Genera pagamenti una tantum per una categoria, su una classe o un elenco di alunni.
// Riusa il filtro alunni di genera-rette e la logica di creazione di pagamenti/rate.

// scuola_id in query: stringa vuota equivale ad assente (come il vecchio
// `searchParams.get(...) || fallback`), poi si ricade su quella dell'utente.
const zScuolaIdQuery = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

const getQuerySchema = z.object({
  scuola_id: zScuolaIdQuery,
  classe_sezione: z.string().optional(),
  gruppo: z.string().optional(),
})

const rataSchema = z.object({
  // gli importi possono arrivare come numero o stringa numerica (come incassi)
  importo: z.coerce.number(),
  scadenza: z.string(),
})

const postBodySchema = z.object({
  descrizione: z.string().optional(),
  importo: z.coerce.number().nullish(),
  scadenza: z.string().nullish(),
  gruppo: z.string().nullish(),
  // il vincolo "almeno 2 rate" resta a runtime: storicamente una lista più corta
  // viene ignorata (si ricade su importo+scadenza), non è un errore
  rate: z.array(rataSchema).optional(),
  alunno_ids: z.array(zUuid).optional(),
  scuola_id: zUuid.nullish(),
  classe_sezione: z.string().nullish(),
  obbligatorio: z.boolean().nullish(),
  categoria_id: zUuid.nullish(),
})

// GET /api/pagamenti/genera?userId=&categoria_id=&classe_sezione=&gruppo=  (staff)
//   Preview: alunni candidati (iscritti con sezione), esclusi quelli che hanno
//   già un pagamento con lo stesso `gruppo`.
export const GET = withRoute('pagamenti/genera:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const scuolaIdClient = q.data.scuola_id
    const classeSezione = q.data.classe_sezione
    const gruppo = q.data.gruppo

    const supabase = await createAdminClient()

    // Scope multi-scuola: MAI fidarsi dello scuola_id del client. Filtra la
    // preview sui plessi accessibili; lo scuolaId del client serve SOLO a
    // restringere dentro quell'insieme (se accessibile).
    const scuoleAccessibili = await resolveScuoleAttive(request, supabase, auth.user)
    const scuoleFiltro =
      scuolaIdClient && scuoleAccessibili.includes(scuolaIdClient)
        ? [scuolaIdClient]
        : scuoleAccessibili

    let alQuery = supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, section_id, scuola_id')
      .eq('stato', 'iscritto')
      .in('scuola_id', scuoleFiltro)
    if (classeSezione) alQuery = alQuery.eq('classe_sezione', classeSezione)
    const { data: alunniRaw } = await alQuery
    const alunni = (alunniRaw || []).filter((a) => a.classe_sezione != null || a.section_id != null)

    // esclude chi ha già un pagamento con lo stesso gruppo
    let giaFatti = new Set<string>()
    if (gruppo) {
      const { data: esistenti } = await supabase
        .from('pagamenti').select('alunno_id').eq('gruppo', gruppo)
      giaFatti = new Set((esistenti || []).map((e) => e.alunno_id))
    }
    const candidati = alunni.filter((a) => !giaFatti.has(a.id))

    return NextResponse.json({
      success: true,
      data: { candidati, gia_generati: giaFatti.size },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/genera  (staff) — conferma generazione
// Body: { userId, categoria_id?, descrizione, importo, scadenza,
//         alunno_ids?: string[], classe_sezione?, obbligatorio?, gruppo?,
//         rate?: [{importo, scadenza}]  // se presente → piano rateale per alunno }
export const POST = withRoute('pagamenti/genera:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { descrizione, importo, scadenza, gruppo } = body
    const rate = body.rate && body.rate.length >= 2 ? body.rate : undefined

    if (!descrizione || (!rate && (importo == null || !scadenza))) {
      return NextResponse.json(
        { error: 'descrizione e (importo + scadenza) oppure rate sono obbligatori' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()

    // Scope multi-sede: MAI fidarsi del client. Qui non si legge un'altra sede,
    // ci si SCRIVE — e con `alunno_ids` non validati una segreteria poteva
    // generare pagamenti (e le notifiche ai genitori) sui bambini di un'altra
    // sede. Lo stesso `scuola_id`, se assente, lasciava la query SENZA filtro.
    const scuoleAccessibili = await resolveScuoleAttive(request, supabase, user)

    // risolve l'elenco alunni target
    let alunnoIds: string[] = body.alunno_ids ?? []
    if (alunnoIds.length > 0) {
      // Elenco esplicito: ogni id dev'essere di un alunno dei propri plessi.
      const { data: ammessi, error: errScope } = await supabase
        .from('alunni').select('id').in('id', alunnoIds).in('scuola_id', scuoleAccessibili)
      if (errScope) {
        logErrore({ operazione: 'pagamenti/genera:POST', stato: 500, evento: 'db' }, errScope)
        return NextResponse.json({ error: 'Verifica di scope non riuscita' }, { status: 500 })
      }
      const inScope = new Set((ammessi ?? []).map((a) => a.id as string))
      const estranei = alunnoIds.filter((id) => !inScope.has(id))
      if (estranei.length > 0) {
        // warn → persistito: è un tentativo di scrittura cross-tenant. Solo
        // conteggi e uuid dell'operatore: nessun dato dei minori coinvolti.
        logEvento('auth', 'warn', {
          tipo: 'alunni-fuori-sede', azione: 'pagamenti/genera:POST',
          utente: user.id, ruolo: user.role, n: estranei.length,
        })
        return NextResponse.json({ error: 'Alunni fuori dal tuo plesso' }, { status: 403 })
      }
    } else {
      // Selezione per NOME-CLASSE: qui la sede dev'essere UNA, e dichiarata.
      // `.in('scuola_id', scuoleAccessibili)` in AND con `.eq('classe_sezione', …)`
      // leggeva «sede non indicata» come «tutte quelle su cui posso operare»:
      // con «2 ANNI» che esiste in più plessi, un solo comando emetteva
      // pagamenti — e le notifiche ai genitori — su due sedi insieme. Una
      // scrittura di massa non deduce il proprio perimetro da un nome ambiguo:
      // `resolveScuolaScrittura` risponde 400 e chiede quale plesso.
      const sw = await resolveScuolaScrittura(request, supabase, user, body.scuola_id)
      if (sw.response) return sw.response
      const scuolaScrittura = sw.scuolaId as string
      let alQuery = supabase.from('alunni').select('id, classe_sezione, section_id')
        .eq('stato', 'iscritto')
        .eq('scuola_id', scuolaScrittura)
      if (body.classe_sezione) alQuery = alQuery.eq('classe_sezione', body.classe_sezione)
      const { data: al, error: errAl } = await alQuery
      if (errAl) {
        logErrore({ operazione: 'pagamenti/genera:POST', stato: 500, evento: 'db' }, errAl)
        return NextResponse.json({ error: 'Errore nel caricamento degli alunni' }, { status: 500 })
      }
      alunnoIds = (al || []).filter((a) => a.classe_sezione != null || a.section_id != null).map((a) => a.id)
    }
    if (alunnoIds.length === 0) {
      return NextResponse.json({ error: 'Nessun alunno selezionato' }, { status: 400 })
    }

    // esclude i duplicati per gruppo
    if (gruppo) {
      const { data: esistenti } = await supabase.from('pagamenti').select('alunno_id').eq('gruppo', gruppo)
      const giaFatti = new Set((esistenti || []).map((e) => e.alunno_id))
      alunnoIds = alunnoIds.filter((id) => !giaFatti.has(id))
    }
    if (alunnoIds.length === 0) {
      return NextResponse.json({ error: 'Tutti gli alunni hanno già questo pagamento' }, { status: 400 })
    }

    // scuola_id per alunno (per coerenza multi-scuola)
    const { data: alunniInfo } = await supabase.from('alunni').select('id, scuola_id').in('id', alunnoIds)
    const scuolaByAlunno = new Map((alunniInfo || []).map((a) => [a.id, a.scuola_id]))

    const obbligatorio = body.obbligatorio ?? true
    const categoriaId = body.categoria_id ?? null

    let generati = 0
    const alunniGenerati: string[] = []

    if (rate) {
      // valida che la somma delle rate coincida col totale
      const somma = rate.reduce((s, r) => s + Number(r.importo), 0)
      const tot = Number(importo ?? somma)
      if (Math.abs(somma - tot) > 0.01) {
        return NextResponse.json({ error: `La somma delle rate (${somma}) deve coincidere col totale (${tot})` }, { status: 400 })
      }
      const ultimaScadenza = rate.map((r) => r.scadenza).sort().slice(-1)[0]

      for (const aId of alunnoIds) {
        const scuolaId = scuolaByAlunno.get(aId)
        const { data: padre, error: pErr } = await supabase.from('pagamenti').insert({
          alunno_id: aId, scuola_id: scuolaId, descrizione, importo: tot, scadenza: ultimaScadenza,
          categoria_id: categoriaId, tipo: 'padre', obbligatorio, gruppo: gruppo ?? null,
          creato_da: user.id, stato: 'da_pagare',
        }).select('id').single()
        if (pErr || !padre) continue
        const figlie = rate.map((r, i) => ({
          alunno_id: aId, scuola_id: scuolaId, descrizione: `${descrizione} — Rata ${i + 1}/${rate.length}`,
          importo: r.importo, scadenza: r.scadenza, categoria_id: categoriaId,
          tipo: 'rata', obbligatorio, parent_payment_id: padre.id, gruppo: gruppo ?? null,
          creato_da: user.id, stato: 'da_pagare',
        }))
        const { error: rErr } = await supabase.from('pagamenti').insert(figlie)
        if (rErr) { await supabase.from('pagamenti').delete().eq('id', padre.id); continue }
        generati += 1
        alunniGenerati.push(aId)
      }
    } else {
      const records = alunnoIds.map((aId) => ({
        alunno_id: aId, scuola_id: scuolaByAlunno.get(aId), descrizione,
        importo, scadenza, categoria_id: categoriaId, tipo: 'singolo',
        obbligatorio, gruppo: gruppo ?? null, creato_da: user.id, stato: 'da_pagare',
      }))
      const { data: created, error } = await supabase.from('pagamenti').insert(records).select('id')
      if (error) {
        logErrore({ operazione: 'pagamenti/genera:POST', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: 'Errore nella generazione', details: error.message }, { status: 500 })
      }
      generati = created?.length ?? 0
      alunniGenerati.push(...alunnoIds)
    }

    // `.then(() => {}, () => {})` scartava sia il successo sia il rifiuto. E
    // PostgREST NON lancia: l'errore torna dentro il risultato, quindi non
    // veniva nemmeno letto. La traccia di chi ha generato in massa i pagamenti
    // poteva non essere scritta e nessuno l'avrebbe mai saputo — e' esattamente
    // il costrutto che il 2026-07-29 aveva reso invisibile per mesi l'audit dei
    // legami genitore/figlio. Best-effort resta (non fa fallire la generazione),
    // ma «saltato» adesso si vede.
    const auditRes = await supabase.from('registro_modifiche').insert({
      azione: 'genera_pagamenti_categoria',
      tabella_interessata: 'pagamenti',
      record_id: null,
      nuovo_valore: { categoria_id: categoriaId, descrizione, gruppo, generati, rate: !!rate },
      utente_id: user.id,
    })
    if (auditRes.error) {
      logEvento('pagamenti', 'error', {
        operazione: 'pagamenti/genera:POST',
        esito: 'audit-non-scritto',
        generati,
      }, auditRes.error)
    }

    // Notifica ai genitori: nuovo dovuto disponibile (best-effort). UNA
    // notifica per genitore (dedup nel wrapper), mai una per pagamento.
    //
    // LA SEDE DELLA NOTIFICA SI DERIVA DAI PAGAMENTI APPENA SCRITTI, non dalla
    // sede primaria di chi ha premuto il bottone: `scuolaId` decide quale
    // toggle «pagamento_emesso» viene consultato (`isNotificaAbilitata`) e
    // resta scritto sulla riga di `notifiche`. Il ripiego su `user.scuola_id`
    // faceva rispondere il toggle del plesso SBAGLIATO ogni volta che l'admin
    // generava per una sede diversa dalla propria — cioè sempre, dal pannello
    // che conferma con `alunno_ids` e non manda `scuola_id`. Sedi miste (solo
    // l'admin può averne) ⇒ `null`, che il wrapper documenta come fail-open:
    // meglio una notifica in più che la configurazione di un plesso a caso.
    if (alunniGenerati.length > 0) {
      const sediGenerate = new Set(
        alunniGenerati.map((aId) => (scuolaByAlunno.get(aId) as string | null | undefined) ?? null),
      )
      await notificaEvento(supabase, {
        tipo: 'pagamento_emesso',
        scuolaId: sediGenerate.size === 1 ? [...sediGenerate][0] : null,
        alunnoIds: alunniGenerati,
        titolo: 'Nuovo pagamento disponibile',
        corpo: `${descrizione}: trovi il dettaglio nella sezione Pagamenti.`,
        link: '/parent/pagamenti',
        entitaTipo: 'pagamento',
      })
    }

    return NextResponse.json({ success: true, data: { generati } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/genera:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
