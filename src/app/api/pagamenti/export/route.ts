import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import * as XLSX from 'xlsx'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { calcolaAttestazione, type VoceAttestazione } from '@/lib/pagamenti/attestazione'
import { resolveParentRegistry, type ParentRegistry } from '@/lib/pagamenti/intestatari'
import { anagraficaDaScheda, nomeDaAnagrafica } from '@/lib/fatturazione/intestatario-scelto'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input ─────────────────────────────────────────────
const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

/**
 * K2 — `section_ids`: uuid di sezione separati da virgola (`?section_ids=a,b`),
 * o ripetuti (`?section_ids=a&section_ids=b`, che `parseQuery` consegna come
 * array). Vuoto ⇒ assente (nessun filtro). Un solo valore non uuid ⇒ 400: un
 * filtro scartato in silenzio produrrebbe l'export di TUTTA la sede spacciato
 * per quello di una classe. Tetto a 200: le sezioni di tre plessi sono decine.
 */
const zSectionIds = z.preprocess((v) => {
  if (v === undefined) return undefined
  const grezzi = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','))
  const puliti = grezzi.map((x) => x.trim()).filter((x) => x !== '')
  return puliti.length === 0 ? undefined : puliti
}, z.array(zUuid).min(1).max(200).optional())

const getQuerySchema = z
  .object({
    tipo: z.enum(['scadenzario', 'ade']),
    scuola_id: zUuidQueryOpzionale,
    stato: z.string().optional(),
    categoria_id: zUuidQueryOpzionale,
    anno: z.coerce.number().int().min(2000).max(2100).optional(),
    section_ids: zSectionIds,
  })
  .refine((q) => q.tipo !== 'ade' || q.anno !== undefined, "l'export AdE richiede l'anno")
// NB: `section_ids` con `tipo=ade` NON è un 400. Prima di K2 zod scartava la
// chiave e la risposta era 200: il compito chiede «resto invariato», e rifiutarla
// romperebbe il download AdE se l'interfaccia riusa la query dello Scadenzario.
// La comunicazione all'Agenzia delle Entrate resta sull'anno e sulla sede per
// intero: il filtro si IGNORA (niente file parziale) e lo si dice nel log.

const STATO_LABEL: Record<string, string> = {
  da_pagare: 'Da pagare', parziale: 'Parziale', pagato: 'Pagato', scaduto: 'Scaduto',
}
const FATTURA_LABEL: Record<string, string> = {
  non_richiesta: 'Da fatturare', in_attesa: 'In attesa SDI', emessa: 'Fatturata', scartata: 'Scartata',
}

interface RigaPagamento {
  scuola_id: string | null
  descrizione: string
  importo: number
  importo_pagato: number | null
  scadenza: string | null
  periodo_competenza: string | null
  stato: string
  tipo: string
  fattura_stato: string | null
  alunni?: { nome?: string; cognome?: string; classe_sezione?: string | null } | null
  payment_categories?: { nome?: string } | null
}

/**
 * K2 — nome di ogni sede in scope, per la colonna «Sede» degli export.
 *
 * Con tre plessi due «Sezione A» sono la stessa stringa: senza la sede la riga
 * non dice di chi è. Se i nomi non si leggono si risponde 500 (PostgREST non
 * lancia: `{ error }` va guardato) invece di consegnare un export con la
 * colonna vuota, che sembrerebbe giusto e non lo è.
 */
async function nomiDelleSedi(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sedi: string[],
): Promise<{ nomi?: Map<string, string>; response?: NextResponse }> {
  const { data, error } = await supabase.from('schools').select('id, nome').in('id', sedi)
  if (error) {
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Errore nel recupero delle sedi', codice: 'LETTURA_FALLITA' }, { status: 500 }) }
  }
  const nomi = new Map<string, string>()
  for (const s of (data ?? []) as { id: string; nome: string | null }[]) nomi.set(s.id, s.nome ?? '')
  return { nomi }
}

// GET /api/pagamenti/export?tipo=scadenzario — XLSX per la segreteria/commercialista
export const GET = withRoute('pagamenti/export:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuola_id: scuolaId, stato, categoria_id: categoriaId } = q.data
    // Il filtro classi vale SOLO per lo Scadenzario: per l'AdE non si applica.
    const sectionIds = q.data.tipo === 'scadenzario' ? q.data.section_ids : undefined
    if (q.data.tipo === 'ade' && q.data.section_ids) {
      logEvento('pagamento', 'info', {
        tipo: 'export-ade-classi-ignorate', azione: 'pagamenti/export:GET',
        utente: user.id, ruolo: user.role, classi: q.data.section_ids.length,
      })
    }

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, user)

    // Accountability GDPR: gli export contengono PII (nomi, sezioni, importi; il
    // ramo AdE anche i codici fiscali). Registra chi esporta cosa e quando.
    await logScrittura(supabase, {
      attore: user,
      entitaTipo: 'export_pagamenti',
      azione: 'insert',
      scuolaId: scuolaId && sediAttive.includes(scuolaId) ? scuolaId : sediAttive[0] ?? null,
      valoreDopo: {
        tipo: q.data.tipo, anno: q.data.anno ?? null, sedi: sediAttive,
        classi: sectionIds ?? null,
      },
    })

    const sedi = await nomiDelleSedi(supabase, sediAttive)
    if (sedi.response) return sedi.response
    const nomiSedi = sedi.nomi!

    if (q.data.tipo === 'ade') {
      return exportAde(supabase, sediAttive, q.data.anno!, nomiSedi)
    }

    // K2 — filtro classi. `!inner` SOLO quando le classi si chiedono: senza,
    // PostgREST non scarta la voce il cui alunno è fuori dalle sezioni, le mette
    // soltanto `alunni: null` — e l'export «della Sezione A» conterrebbe tutta la
    // sede. Senza filtro resta il join normale, così le voci senza alunno restano.
    const embedAlunni = sectionIds
      ? 'alunni!inner ( nome, cognome, classe_sezione, section_id )'
      : 'alunni ( nome, cognome, classe_sezione )'
    let query = supabase
      .from('pagamenti')
      .select(`
        scuola_id, descrizione, importo, importo_pagato, scadenza, periodo_competenza, stato, tipo, fattura_stato,
        payment_categories ( nome ),
        ${embedAlunni}
      `)
      .in('scuola_id', sediAttive)
      .order('scadenza', { ascending: true })
    if (scuolaId && sediAttive.includes(scuolaId)) query = query.eq('scuola_id', scuolaId)
    if (stato) query = query.eq('stato', stato)
    if (categoriaId) query = query.eq('categoria_id', categoriaId)
    if (sectionIds) query = query.in('alunni.section_id', sectionIds)

    const { data, error } = await query
    if (error) {
      logErrore({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti' }, { status: 500 })
    }

    // I contenitori padre non sono voci esigibili: nell'export contano le rate.
    const righe = ((data || []) as unknown as RigaPagamento[])
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        // K2 — prima colonna: con più plessi è la prima cosa che serve sapere.
        Sede: p.scuola_id ? (nomiSedi.get(p.scuola_id) ?? '') : '',
        Alunno: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' '),
        Sezione: p.alunni?.classe_sezione ?? '',
        Categoria: p.payment_categories?.nome ?? '',
        Descrizione: p.descrizione,
        Scadenza: p.scadenza ?? '',
        'Importo €': Number(p.importo),
        'Pagato €': Number(p.importo_pagato || 0),
        'Residuo €': Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0)),
        Stato: STATO_LABEL[p.stato] ?? p.stato,
        Fattura: p.stato === 'pagato' ? (FATTURA_LABEL[p.fattura_stato ?? 'non_richiesta'] ?? '') : '',
      }))

    const ws = XLSX.utils.json_to_sheet(righe)
    ws['!cols'] = [{ wch: 20 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 34 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Scadenzario')
    // Nessun dato personale: conteggi e numero di classi filtrate.
    logEvento('pagamento', 'info', {
      tipo: 'export-scadenzario', azione: 'pagamenti/export:GET',
      utente: user.id, ruolo: user.role, attive: sediAttive.length,
      classi: sectionIds?.length ?? 0, n: righe.length,
    })

    // SheetJS ritorna Buffer in Node: cast ad ArrayBuffer per NextResponse
    const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
    const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
    const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
    const oggi = oggiFiscaleISO()
    return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="scadenzario-${oggi}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

interface AlunnoAde {
  id: string
  nome?: string | null
  cognome?: string | null
  codice_fiscale?: string | null
  opposizione_ade?: boolean | null
  intestatario_fatture?: { tipo?: string | null; adult_id?: string | null; dati?: unknown } | null
  scuola_id?: string | null
}
interface IncassoAde {
  importo: number
  metodo?: string | null
  pagamenti?: {
    alunno_id: string
    descrizione?: string | null
    payment_categories?: { slug?: string | null } | null
  } | null
}

// Export per la comunicazione delle spese scolastiche all'AdE (obbligo dal
// periodo d'imposta 2022, invio entro il 16 marzo): criterio di cassa
// sull'anno solare, SOLO quote tracciabili di categorie ammesse. Il foglio
// "Escluse" motiva ogni esclusione (opposizione, contanti, categorie
// non detraibili, CF pagatore mancante) per il controllo del commercialista.
async function exportAde(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sediAttive: string[],
  anno: number,
  nomiSedi: Map<string, string>,
) {
  // select('*') sugli alunni: tollera i DB senza opposizione_ade (e2e CI).
  const { data: alunniRaw, error: errAlunni } = await supabase
    .from('alunni')
    .select('*')
    .in('scuola_id', sediAttive)
  if (errAlunni) {
    // `exportAde` è un ramo della stessa route: `operazione` resta quella di `withRoute`.
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }, errAlunni)
    return NextResponse.json({ error: 'Errore nel recupero degli alunni' }, { status: 500 })
  }

  const { data: incassiRaw, error: errIncassi } = await supabase
    .from('incassi')
    .select('importo, metodo, data_incasso, pagamenti!inner ( alunno_id, scuola_id, descrizione, payment_categories ( slug ) )')
    .gte('data_incasso', `${anno}-01-01`)
    .lte('data_incasso', `${anno}-12-31`)
    .in('pagamenti.scuola_id', sediAttive)
  if (errIncassi) {
    logErrore({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }, errIncassi)
    return NextResponse.json({ error: 'Errore nel recupero degli incassi' }, { status: 500 })
  }

  const perAlunno = new Map<string, VoceAttestazione[]>()
  for (const i of (incassiRaw || []) as unknown as IncassoAde[]) {
    const alunnoId = i.pagamenti?.alunno_id
    if (!alunnoId) continue
    const arr = perAlunno.get(alunnoId) ?? []
    arr.push({
      importo: i.importo,
      metodo: i.metodo,
      categoria_slug: i.pagamenti?.payment_categories?.slug ?? null,
      descrizione: i.pagamenti?.descrizione ?? '—',
    })
    perAlunno.set(alunnoId, arr)
  }

  const regCache = new Map<string, ParentRegistry | null>()
  const daComunicare: Record<string, unknown>[] = []
  const escluse: Record<string, unknown>[] = []

  for (const al of (alunniRaw || []) as unknown as AlunnoAde[]) {
    const voci = perAlunno.get(al.id) ?? []
    if (voci.length === 0) continue
    const r = calcolaAttestazione(voci)
    const nome = `${al.nome ?? ''} ${al.cognome ?? ''}`.trim()
    // K2 — la sede dell'ALUNNO, prima colonna di entrambi i fogli.
    const sede = al.scuola_id ? (nomiSedi.get(al.scuola_id) ?? '') : ''

    if (r.nonTracciabile > 0) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'quota non tracciabile (contanti/altro)', 'Importo €': r.nonTracciabile })
    }
    if (r.escluso > 0) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'categoria non detraibile (divise/materiale)', 'Importo €': r.escluso })
    }
    if (r.detraibile <= 0) continue

    if (al.opposizione_ade) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'opposizione della famiglia alla comunicazione', 'Importo €': r.detraibile })
      continue
    }

    // L'intestatario DIGITATO sulla scheda (`tipo: 'altro'`) non ha una riga
    // `parents`: leggere solo `adult_id` escludeva la riga per «codice fiscale del
    // pagatore mancante» — cioè toglieva a quella famiglia la detrazione, con una
    // motivazione che descriveva il nostro codice invece del suo caso.
    // ⚠️ L'opposizione della famiglia resta dov'è, PRIMA di qui: un intestatario
    // digitato non deve poter far comunicare all'Agenzia delle Entrate una spesa
    // che qualcuno ha chiesto di non comunicare.
    const digitata = anagraficaDaScheda(al.intestatario_fatture)
    const adultId = digitata ? null : al.intestatario_fatture?.adult_id ?? null
    let reg: ParentRegistry | null = null
    if (adultId) {
      if (regCache.has(adultId)) reg = regCache.get(adultId) ?? null
      else {
        reg = await resolveParentRegistry(supabase, adultId)
        regCache.set(adultId, reg)
      }
    }
    const cfPagatore = digitata ? (digitata.codice_fiscale ?? '') : (reg?.fiscal_code ?? '')
    if (!cfPagatore) {
      escluse.push({ Sede: sede, Alunno: nome, Motivo: 'codice fiscale del pagatore mancante', 'Importo €': r.detraibile })
      continue
    }

    daComunicare.push({
      Sede: sede,
      'CF alunno': al.codice_fiscale ?? '',
      Alunno: nome,
      'CF pagatore': cfPagatore,
      Pagatore: digitata
        ? nomeDaAnagrafica(digitata)
        : [reg?.first_name, reg?.last_name].filter(Boolean).join(' '),
      'Importo comunicabile €': r.detraibile,
      Anno: anno,
    })
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(daComunicare), 'Da comunicare')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(escluse), 'Escluse')

  const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
  const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
  return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="comunicazione-ade-${anno}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
