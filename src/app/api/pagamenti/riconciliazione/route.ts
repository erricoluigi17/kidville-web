import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import {
  hashMovimento,
  parseCsv,
  suggerisciMatch,
  type PagamentoAperto,
} from '@/lib/pagamenti/riconciliazione'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())
// `z.iso.date()` valida una data ISO REALE (giorno/mese esistenti), non solo la forma YYYY-MM-DD:
// così un input impossibile come 2026-13-40 / 2026-02-30 è respinto qui (→ 400 warn) e non arriva
// mai a `.gte/.lte`, dove Postgres esploderebbe (22008) e riempirebbe il canale ERROR con un
// errore di INPUT utente. Vale per `da` e `a`.
const zDataQueryOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.iso.date('Data non valida (atteso YYYY-MM-DD reale)').optional(),
)

const getQuerySchema = z.object({
  stato: z.enum(['da_abbinare', 'suggerito', 'confermato', 'ignorato']).or(z.literal('')).optional(),
  import_id: zUuidQueryOpzionale,
  // Intervallo su data_operazione (estremi inclusi).
  da: zDataQueryOpzionale,
  a: zDataQueryOpzionale,
})

const postBodySchema = z.object({
  filename: z.string().max(200).optional(),
  // contenuto CSV in chiaro: PII bancarie → si persistono SOLO i movimenti normalizzati
  contenuto: z.string().min(1).max(2_000_000),
  mapping: z
    .object({
      data: z.string().max(80).optional(),
      importo: z.string().max(80).optional(),
      causale: z.string().max(80).optional(),
      controparte: z.string().max(80).optional(),
    })
    .optional(),
  scuola_id: zUuid.nullish(),
})

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

interface SuggerimentoRiga { pagamento_id: string; label?: string | null; [k: string]: unknown }
interface MovimentoRiga { suggerimenti?: SuggerimentoRiga[] | null; [k: string]: unknown }

// GET /api/pagamenti/riconciliazione?stato=&import_id=&da=&a= — registro movimenti (staff).
// Registro CUMULATIVO GLOBALE: l'estratto conto della banca è unico e cross-sede, quindi ogni
// segreteria vede TUTTE le RIGHE bancarie (data/importo/causale/controparte/stato, ogni stato):
// è l'estratto conto condiviso del titolare. La sede si assegna solo alla conferma, quindi filtrare
// le righe per sede nasconderebbe proprio quelle ancora da lavorare (scuola_id = null).
// MINIMIZZAZIONE IN LETTURA (privacy, dati di minori): i `suggerimenti` portano però il NOME del
// minore (label). Quello è arricchimento identificante: si mostra SOLO per le PROPRIE sedi. Sotto,
// dopo aver caricato le righe, si risolve la sede di ogni pagamento citato (una query batch) e si
// tengono nei suggerimenti solo quelli in sede attiva; la riga bancaria resta invece globale.
export const GET = withRoute('pagamenti/riconciliazione:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()

    let query = supabase
      .from('riconciliazione_movimenti')
      .select('id, import_id, scuola_id, data_operazione, importo, causale, controparte, stato, suggerimenti, pagamento_id, confermato_il')
      .order('data_operazione', { ascending: false })
      .limit(500)
    if (q.data.stato) query = query.eq('stato', q.data.stato)
    if (q.data.import_id) query = query.eq('import_id', q.data.import_id)
    if (q.data.da) query = query.gte('data_operazione', q.data.da)
    if (q.data.a) query = query.lte('data_operazione', q.data.a)

    const { data, error } = await query
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: [], disponibile: false })
      return NextResponse.json({ error: 'Errore nel recupero dei movimenti' }, { status: 500 })
    }
    const righe = (data || []) as MovimentoRiga[]

    // Pagamenti citati dai suggerimenti: se nessuno, niente arricchimento da minimizzare.
    const pagIds = [...new Set(
      righe.flatMap((r) => (r.suggerimenti ?? []).map((s) => s.pagamento_id)).filter(Boolean),
    )]
    if (pagIds.length === 0) return NextResponse.json({ success: true, data: righe })

    const sediAttive = new Set(await resolveScuoleAttive(request, supabase, auth.user))
    const { data: pagSedi, error: errSedi } = await supabase
      .from('pagamenti')
      .select('id, scuola_id')
      .in('id', pagIds)
    if (errSedi || !pagSedi) {
      // Degrado prudente: senza la mappa sede non distinguiamo le proprie sedi dalle altre →
      // togliamo l'arricchimento identificante (il nome) da TUTTI i suggerimenti. Meglio ometterlo
      // che rischiare di esporre il nome di un minore di un altro plesso.
      logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:GET', esito: 'sedi_suggerimenti_non_risolte' }, errSedi)
      const oscurati = righe.map((r) =>
        r.suggerimenti ? { ...r, suggerimenti: r.suggerimenti.map((s) => ({ ...s, label: null })) } : r,
      )
      return NextResponse.json({ success: true, data: oscurati })
    }
    const sedeDi = new Map(
      (pagSedi as { id: string; scuola_id: string | null }[]).map((p) => [p.id, p.scuola_id]),
    )
    const minimizzate = righe.map((r) =>
      r.suggerimenti
        ? {
            ...r,
            suggerimenti: r.suggerimenti.filter((s) => {
              const sede = sedeDi.get(s.pagamento_id)
              return sede != null && sediAttive.has(sede)
            }),
          }
        : r,
    )
    return NextResponse.json({ success: true, data: minimizzate })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/riconciliazione — import CSV estratto conto (staff).
// Parse + hash anti re-import GLOBALE + suggerimenti calcolati SUBITO sui pagamenti aperti di
// TUTTE le sedi (aggancio per codice fiscale, poi importo/nome/periodo/descrizione). I movimenti
// nascono senza sede (scuola_id null): la sede si assegna alla conferma. Nessuna conferma automatica.
export const POST = withRoute('pagamenti/riconciliazione:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, body.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { movimenti, scartate } = parseCsv(body.contenuto, body.mapping)
    if (movimenti.length === 0) {
      return NextResponse.json(
        { error: 'Nessun accredito riconosciuto nel file: controlla intestazioni/mapping o il separatore' },
        { status: 400 },
      )
    }

    // dedup nel file + contro il registro esistente
    const visti = new Set<string>()
    const conHash = movimenti
      .map((m) => ({ m, hash: hashMovimento(m) }))
      .filter(({ hash }) => (visti.has(hash) ? false : (visti.add(hash), true)))

    // DEDUP GLOBALE: l'UNIQUE su hash_movimento è ora globale (non più per sede) e l'estratto
    // conto è unico → il controllo anti re-import NON filtra per scuola_id (dedup su tutto il registro).
    const { data: giaRows, error: errEsistenti } = await supabase
      .from('riconciliazione_movimenti')
      .select('hash_movimento')
      .in('hash_movimento', conHash.map((x) => x.hash))
    if (errEsistenti) {
      if (SCHEMA_MANCANTE.has(errEsistenti.code ?? '')) {
        return NextResponse.json({ error: 'Riconciliazione non ancora disponibile.' }, { status: 503 })
      }
      return NextResponse.json({ error: 'Errore nel controllo duplicati' }, { status: 500 })
    }
    const gia = new Set(((giaRows || []) as { hash_movimento: string }[]).map((r) => r.hash_movimento))
    const nuovi = conHash.filter(({ hash }) => !gia.has(hash))
    const duplicati = conHash.length - nuovi.length
    // Un secondo bonifico identico non deve sparire in silenzio: si logga QUANTI ne saltiamo.
    if (duplicati > 0) {
      logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:POST', esito: 'duplicati_saltati', duplicati })
    }

    // Pagamenti aperti di TUTTE le sedi: l'estratto conto è globale e questo è un client
    // service-role. Il CF dell'alunno è l'aggancio più forte (`codice_fiscale`, con fallback
    // sullo storico `fiscal_code`).
    // FIX collaudo: l'ERRORE della SELECT non si scarta. Il matching per CF/nome è il CUORE
    // dell'import: se questa SELECT fallisce, `aperti` resterebbe vuoto e la rotta loggerebbe
    // comunque `import_ok` con `con_cf:0` — un successo che MENTE. Quindi:
    //  • 42703 (colonna CF assente sul DB E2E CI non migrato) → si ritenta SENZA le colonne CF,
    //    coerente col resto della codebase: l'import degrada senza aggancio per codice fiscale;
    //  • qualunque altro errore → si INTERROMPE l'import (500 + logErrore), niente `import_ok`.
    const APERTI_SELECT_CF = 'id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunno_id, alunni:alunno_id ( nome, cognome, codice_fiscale, fiscal_code )'
    const APERTI_SELECT_BASE = 'id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunno_id, alunni:alunno_id ( nome, cognome )'
    // `apertiRaw` normalizzato a `unknown[] | null`: la SELECT con CF e quella senza hanno tipi
    // literal diversi (l'embed `alunni` differisce) → tenerli in un `let` tipizzato darebbe conflitto.
    // Il downstream fa comunque `as unknown as {…}` sul mapping, quindi il tipo preciso qui non serve.
    const primaSelezione = await supabase
      .from('pagamenti')
      .select(APERTI_SELECT_CF)
      .in('stato', ['da_pagare', 'parziale', 'scaduto'])
    let apertiRaw: unknown[] | null = primaSelezione.data
    let errAperti = primaSelezione.error
    if (errAperti?.code === '42703') {
      logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:POST', esito: 'degradazione_cf_aperti' })
      const senzaCf = await supabase
        .from('pagamenti')
        .select(APERTI_SELECT_BASE)
        .in('stato', ['da_pagare', 'parziale', 'scaduto'])
      apertiRaw = senzaCf.data
      errAperti = senzaCf.error
    }
    if (errAperti) {
      logErrore({ operazione: 'pagamenti/riconciliazione:POST', evento: 'aperti_select_fallita', stato: 500 }, errAperti)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti aperti' }, { status: 500 })
    }
    const aperti: PagamentoAperto[] = ((apertiRaw || []) as unknown as {
      id: string; descrizione?: string | null; importo: number; importo_pagato?: number | null
      periodo_competenza?: string | null; tipo: string; alunno_id?: string | null
      alunni?: { nome?: string; cognome?: string; codice_fiscale?: string | null; fiscal_code?: string | null } | null
    }[])
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        id: p.id,
        descrizione: p.descrizione,
        importo: p.importo,
        importo_pagato: p.importo_pagato,
        periodo_competenza: p.periodo_competenza,
        alunno_id: p.alunno_id ?? null,
        codice_fiscale: p.alunni?.codice_fiscale ?? p.alunni?.fiscal_code ?? null,
        alunno_nome: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ') || null,
      }))
    const labels = new Map(
      aperti.map((p) => [
        p.id,
        `${p.alunno_nome ?? '—'} · ${p.descrizione ?? '—'} (residuo € ${(Number(p.importo) - Number(p.importo_pagato || 0)).toFixed(2)})`,
      ]),
    )

    // Il movimento nasce SENZA sede (scuola_id null): la sede si assegna alla conferma.
    // DEGRADAZIONE CI: sul DB E2E non migrato scuola_id è ancora NOT NULL → 23502; si ritenta
    // con la sede risolta dell'operatore (`resolveScuolaScrittura`).
    const impBase = { filename: body.filename ?? null, righe_totali: nuovi.length, caricato_da: auth.user.id }
    let { data: imp, error: errImp } = await supabase
      .from('riconciliazione_import')
      .insert({ ...impBase, scuola_id: null })
      .select()
      .single()
    if (errImp?.code === '23502') {
      logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:POST', esito: 'degradazione_scuola_id_import' })
      ;({ data: imp, error: errImp } = await supabase
        .from('riconciliazione_import')
        .insert({ ...impBase, scuola_id: scuolaId })
        .select()
        .single())
    }
    if (errImp || !imp) {
      return NextResponse.json({ error: "Errore nella creazione dell'import" }, { status: 500 })
    }

    let suggeriti = 0
    let conCf = 0
    const righe = nuovi.map(({ m, hash }) => {
      const s = suggerisciMatch(m, aperti)
      if (s.stato === 'suggerito') suggeriti++
      if (s.cf_match && s.cf_match.length > 0) conCf++
      return {
        import_id: (imp as { id: string }).id,
        scuola_id: null as string | null,
        data_operazione: m.data_operazione,
        importo: m.importo,
        causale: m.causale || null,
        controparte: m.controparte || null,
        hash_movimento: hash,
        stato: s.stato,
        suggerimenti: s.suggerimenti.map((x) => ({ ...x, label: labels.get(x.pagamento_id) ?? null })),
      }
    })
    if (righe.length > 0) {
      let { error: errIns } = await supabase.from('riconciliazione_movimenti').insert(righe)
      if (errIns?.code === '23502') {
        logEvento('pagamento', 'info', { operazione: 'pagamenti/riconciliazione:POST', esito: 'degradazione_scuola_id_movimenti' })
        const righeConSede = righe.map((r) => ({ ...r, scuola_id: scuolaId }))
        ;({ error: errIns } = await supabase.from('riconciliazione_movimenti').insert(righeConSede))
      }
      if (errIns) return NextResponse.json({ error: 'Errore nel salvataggio dei movimenti' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'riconciliazione_import',
      entitaId: (imp as { id: string }).id,
      azione: 'insert',
      scuolaId,
      valoreDopo: { filename: body.filename ?? null, nuovi: righe.length, duplicati },
    })

    // Log di SUCCESSO con i soli CONTEGGI (mai PII: niente causale/CF/nomi). 'pagamento' è un
    // evento persistito → il successo dell'import resta tracciato, non solo gli errori.
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/riconciliazione:POST',
      esito: 'import_ok',
      totali: movimenti.length,
      nuovi: righe.length,
      duplicati,
      scartate,
      suggeriti,
      con_cf: conCf,
    })

    return NextResponse.json({
      success: true,
      data: {
        import_id: (imp as { id: string }).id,
        nuovi: righe.length,
        duplicati,
        scartate,
        suggeriti,
        con_cf: conCf,
        da_abbinare: righe.length - suggeriti,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
