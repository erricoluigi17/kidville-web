import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import {
  decisioneRevisione,
  nomeIntestatarioDaSnapshot,
  ordinaCandidati,
  type AnomaliaSedePagamento,
  type CandidatoRevisioneFattura,
  type ElencoRevisioneFattureWire,
  type FatturaRevisioneWire,
  type RevisioneSalvata,
} from '@/lib/pagamenti/revisione-fatture'

const OPERAZIONE = 'pagamenti/fattura/revisione:GET'
const CODICE_LETTURA_FALLITA = 'LETTURA_FALLITA'
const BLOCCO_METADATI = 500
const BLOCCO_IN = 200

const querySchema = z.object({
  scuola_id: zUuid,
  pagina: z.coerce.number().int().min(1).default(1),
  per_pagina: z.coerce.number().int().min(1).max(50).default(25),
})

interface RigaFatturaDb {
  id: string
  pagamento_id: string
  scuola_id: string
  numero: number
  anno: number
  intestatario: unknown
  sdi_stato: number | null
  pdf_path: string | null
  modalita_emissione: 'ordinaria' | 'quote_separate' | null
  parent_registry_id: string | null
  creato_il: string | null
}

interface RigaRevisioneDb extends RevisioneSalvata {
  fattura_id: string
}

interface RigaPagamentoDb {
  id: string
  scuola_id: string | null
  alunno_id: string | null
}

interface RigaParentDb {
  id: string
  first_name: string | null
  last_name: string | null
  fiscal_code: string | null
  auth_user_id: string | null
}

class ErroreLettura extends Error {
  constructor(readonly esito: string, readonly causa?: unknown) {
    super('lettura-fatture-visibilita-fallita')
    this.name = 'ErroreLettura'
  }
}

function senzaCache<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

function blocchi<T>(valori: T[], dimensione: number): T[][] {
  const risultato: T[][] = []
  for (let indice = 0; indice < valori.length; indice += dimensione) {
    risultato.push(valori.slice(indice, indice + dimensione))
  }
  return risultato
}

async function leggiFattureSede(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  scuolaId: string,
): Promise<RigaFatturaDb[]> {
  const tutte: RigaFatturaDb[] = []
  for (let da = 0; ; da += BLOCCO_METADATI) {
    const { data, error } = await supabase
      .from('fatture_emesse')
      .select(
        'id, pagamento_id, scuola_id, numero, anno, intestatario, sdi_stato, pdf_path, modalita_emissione, parent_registry_id, creato_il',
      )
      .eq('scuola_id', scuolaId)
      .order('creato_il', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(da, da + BLOCCO_METADATI - 1)
    if (error) throw new ErroreLettura('fatture-non-lette', error)
    const righe = (data ?? []) as RigaFatturaDb[]
    tutte.push(...righe)
    if (righe.length < BLOCCO_METADATI) return tutte
  }
}

async function leggiRevisioni(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  fatturaIds: string[],
): Promise<Map<string, RigaRevisioneDb>> {
  const risultato = new Map<string, RigaRevisioneDb>()
  for (const gruppo of blocchi(fatturaIds, BLOCCO_IN)) {
    const { data, error } = await supabase
      .from('fatture_visibilita_revisioni')
      .select('fattura_id, modalita, parent_registry_id, verificata_il, verificata_da')
      .in('fattura_id', gruppo)
    if (error) throw new ErroreLettura('revisioni-non-lette', error)
    for (const riga of (data ?? []) as RigaRevisioneDb[]) risultato.set(riga.fattura_id, riga)
  }
  return risultato
}

async function candidatiPerFattura(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  fatture: RigaFatturaDb[],
): Promise<{
  perFattura: Map<string, CandidatoRevisioneFattura[]>
  anomalie: Map<string, AnomaliaSedePagamento>
}> {
  const perFattura = new Map<string, CandidatoRevisioneFattura[]>()
  const anomalie = new Map<string, AnomaliaSedePagamento>()
  if (fatture.length === 0) return { perFattura, anomalie }

  const pagamentoIds = [...new Set(fatture.map((fattura) => fattura.pagamento_id))]
  const { data: datiPagamenti, error: errorePagamenti } = await supabase
    .from('pagamenti')
    .select('id, scuola_id, alunno_id')
    .in('id', pagamentoIds)
  if (errorePagamenti) throw new ErroreLettura('pagamenti-non-letti', errorePagamenti)
  const pagamenti = new Map(
    ((datiPagamenti ?? []) as RigaPagamentoDb[]).map((pagamento) => [pagamento.id, pagamento]),
  )

  const alunnoPerFattura = new Map<string, string>()
  for (const fattura of fatture) {
    const pagamento = pagamenti.get(fattura.pagamento_id)
    if (!pagamento) {
      anomalie.set(fattura.id, 'pagamento_non_trovato')
      continue
    }
    if (pagamento.scuola_id !== fattura.scuola_id) {
      anomalie.set(fattura.id, 'sede_pagamento_disallineata')
      continue
    }
    if (pagamento.alunno_id) alunnoPerFattura.set(fattura.id, pagamento.alunno_id)
  }

  const alunnoIds = [...new Set(alunnoPerFattura.values())]
  if (alunnoIds.length === 0) return { perFattura, anomalie }

  const [legamiAnagrafici, legamiRuntime] = await Promise.all([
    supabase
      .from('student_parents')
      .select('student_id, parent_id')
      .in('student_id', alunnoIds),
    supabase
      .from('legame_genitori_alunni')
      .select('alunno_id, genitore_id')
      .in('alunno_id', alunnoIds),
  ])
  if (legamiAnagrafici.error) {
    throw new ErroreLettura('legami-anagrafici-non-letti', legamiAnagrafici.error)
  }
  if (legamiRuntime.error) {
    throw new ErroreLettura('legami-runtime-non-letti', legamiRuntime.error)
  }

  const righeAnagrafiche = (legamiAnagrafici.data ?? []) as Array<{
    student_id: string
    parent_id: string
  }>
  const righeRuntime = (legamiRuntime.data ?? []) as Array<{
    alunno_id: string
    genitore_id: string
  }>
  const parentIds = [...new Set(righeAnagrafiche.map((riga) => riga.parent_id))]
  const accountIds = [...new Set(righeRuntime.map((riga) => riga.genitore_id))]

  const [parentsDiretti, parentsDalPonte] = await Promise.all([
    parentIds.length > 0
      ? supabase
          .from('parents')
          .select('id, first_name, last_name, fiscal_code, auth_user_id')
          .in('id', parentIds)
      : Promise.resolve({ data: [], error: null }),
    accountIds.length > 0
      ? supabase
          .from('parents')
          .select('id, first_name, last_name, fiscal_code, auth_user_id')
          .in('auth_user_id', accountIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (parentsDiretti.error) throw new ErroreLettura('parents-anagrafici-non-letti', parentsDiretti.error)
  if (parentsDalPonte.error) throw new ErroreLettura('parents-ponte-non-letti', parentsDalPonte.error)

  const parents = new Map<string, RigaParentDb>()
  for (const parent of [
    ...((parentsDiretti.data ?? []) as RigaParentDb[]),
    ...((parentsDalPonte.data ?? []) as RigaParentDb[]),
  ]) parents.set(parent.id, parent)

  const parentIdsPerAlunno = new Map<string, Set<string>>()
  const aggiungi = (alunnoId: string, parentId: string) => {
    const esistenti = parentIdsPerAlunno.get(alunnoId) ?? new Set<string>()
    esistenti.add(parentId)
    parentIdsPerAlunno.set(alunnoId, esistenti)
  }
  for (const riga of righeAnagrafiche) aggiungi(riga.student_id, riga.parent_id)
  const parentPerAccount = new Map<string, string>()
  for (const parent of parents.values()) {
    if (parent.auth_user_id) parentPerAccount.set(parent.auth_user_id, parent.id)
  }
  for (const riga of righeRuntime) {
    const parentId = parentPerAccount.get(riga.genitore_id)
    if (parentId) aggiungi(riga.alunno_id, parentId)
  }

  for (const [fatturaId, alunnoId] of alunnoPerFattura) {
    const candidati: CandidatoRevisioneFattura[] = []
    for (const parentId of parentIdsPerAlunno.get(alunnoId) ?? []) {
      const parent = parents.get(parentId)
      if (!parent) continue
      candidati.push({
        id: parent.id,
        nome: parent.first_name ?? '',
        cognome: parent.last_name ?? '',
        codice_fiscale: parent.fiscal_code ?? null,
        account_collegato: Boolean(parent.auth_user_id),
      })
    }
    perFattura.set(fatturaId, ordinaCandidati(candidati))
  }

  return { perFattura, anomalie }
}

export const GET = withRoute('pagamenti/fattura/revisione:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return senzaCache(auth.response)

  const query = parseQuery(request, querySchema)
  if ('response' in query) return senzaCache(query.response)

  try {
    const supabase = await createAdminClient()
    const sede = await resolveScuolaScrittura(
      request,
      supabase,
      auth.user,
      query.data.scuola_id,
    )
    if (sede.response) return senzaCache(sede.response)
    const scuolaId = sede.scuolaId!

    const { data: impostazioni, error: erroreImpostazioni } = await supabase
      .from('admin_settings')
      .select('fatture_visibilita_attiva_il')
      .eq('scuola_id', scuolaId)
      .maybeSingle()
    if (erroreImpostazioni) throw new ErroreLettura('impostazioni-non-lette', erroreImpostazioni)
    if (!impostazioni) throw new ErroreLettura('impostazioni-non-trovate')

    const tutte = await leggiFattureSede(supabase, scuolaId)
    const revisioni = await leggiRevisioni(supabase, tutte.map((fattura) => fattura.id))
    const offset = (query.data.pagina - 1) * query.data.per_pagina
    const pagina = tutte.slice(offset, offset + query.data.per_pagina)
    const { perFattura: candidati, anomalie } = await candidatiPerFattura(supabase, pagina)

    const fatture: FatturaRevisioneWire[] = pagina.map((fattura) => {
      const revisione = revisioni.get(fattura.id) ?? null
      return {
        id: fattura.id,
        pagamento_id: fattura.pagamento_id,
        scuola_id: fattura.scuola_id,
        numero: fattura.numero,
        anno: fattura.anno,
        intestatario: nomeIntestatarioDaSnapshot(fattura.intestatario),
        sdi_stato: fattura.sdi_stato,
        ha_pdf: Boolean(fattura.pdf_path),
        ...decisioneRevisione(
          fattura.modalita_emissione,
          fattura.parent_registry_id,
          revisione,
        ),
        candidati: candidati.get(fattura.id) ?? [],
        anomalia: anomalie.get(fattura.id) ?? null,
      }
    })

    const irrisolte = tutte.flatMap((fattura) => {
      const revisione = revisioni.get(fattura.id)
      if (fattura.modalita_emissione !== null || revisione?.modalita !== 'irrisolta') return []
      return [{
        id: fattura.id,
        numero: fattura.numero,
        anno: fattura.anno,
        intestatario: nomeIntestatarioDaSnapshot(fattura.intestatario),
      }]
    })
    const risposta: ElencoRevisioneFattureWire = {
      fatture,
      pagina: query.data.pagina,
      per_pagina: query.data.per_pagina,
      totale: tutte.length,
      attiva_il: typeof impostazioni.fatture_visibilita_attiva_il === 'string'
        ? impostazioni.fatture_visibilita_attiva_il
        : null,
      da_verificare: tutte.filter(
        (fattura) => fattura.modalita_emissione === null && !revisioni.has(fattura.id),
      ).length,
      revisionate: revisioni.size,
      irrisolte,
    }
    return senzaCache(NextResponse.json({ success: true, data: risposta }))
  } catch (errore) {
    if (errore instanceof ErroreLettura) {
      logEvento('fattura', 'error', {
        operazione: OPERAZIONE,
        esito: errore.esito,
        scuola_id: query.data.scuola_id,
      }, errore.causa)
    } else {
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, errore)
    }
    return senzaCache(NextResponse.json(
      { error: 'Lettura delle fatture non riuscita', codice: CODICE_LETTURA_FALLITA },
      { status: 500 },
    ))
  }
})
