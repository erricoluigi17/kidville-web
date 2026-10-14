import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { eDirezione, RUOLI_DIREZIONE } from '@/lib/auth/predicati-ruolo'
import { sediLetturaCassa, nomiSediCassa } from '@/lib/cassa/lettura-multisede'
import { CASSA_SCHEMA_ASSENTE } from '@/lib/cassa/saldo'
import type { DettaglioCassa } from '@/lib/cassa/dettaglio'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const operazione = 'pagamenti/cassa/dettaglio:GET'
const zOpt = <S extends z.ZodType>(schema: S) => z.preprocess((v) => v || undefined, schema.optional())
const getQuerySchema = z.object({
  tipo: z.enum(['entrata', 'uscita']),
  scuola_id: zOpt(zUuid),
  categoria_id: zOpt(z.union([zUuid, z.literal('senza')])),
  da: zOpt(zDataYMD),
  a: zOpt(zDataYMD),
  metodo: zOpt(z.enum(['contanti', 'bonifico', 'pos', 'assegno', 'altro', 'carta'])),
  pagina: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(50),
}).refine((q) => !q.da || !q.a || q.da <= q.a, {
  path: ['a'], message: 'La data finale deve essere successiva o uguale a quella iniziale',
}).refine((q) => (q.pagina - 1) * q.limite <= 2_147_483_647, {
  path: ['pagina'], message: 'Pagina fuori intervallo',
})

// L'RPC restituisce un solo JSON: se non è completo non si pubblica un 200 parziale.
const rpcSchema = z.object({
  righe: z.array(z.object({
    id: zUuid,
    origine: z.enum(['incasso', 'cassa']),
    scuola_id: zUuid,
    scuola_nome: z.string().nullable(),
    data: zDataYMD,
    categoria_id: zUuid.nullable(),
    categoria_nome: z.string().nullable(),
    metodo: z.string(),
    importo: z.number().finite(),
    descrizione: z.string().nullable(),
    note: z.string().nullable(),
    allegato_path: z.string().nullable(),
    storno_di: zUuid.nullable(),
    stornato_il: z.string().nullable(),
    pagamento_id: zUuid.nullable(),
  })),
  conteggio: z.number().int().nonnegative(),
  totale: z.number().finite(),
  contanti: z.number().finite(),
  altri: z.number().finite(),
})

function noStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export const GET = withRoute('pagamenti/cassa/dettaglio:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return noStore(q.response)

    // Il gate confronta i ruoli reali: il cookie del ruolo attivo non concede accessi.
    const auth = q.data.tipo === 'entrata'
      ? await requireStaff(request, RUOLI_DIREZIONE)
      : await requireStaff(request)
    if (auth.response) return noStore(auth.response)

    const supabase = await createAdminClient()
    const scope = await sediLetturaCassa(request, supabase, auth.user, q.data.scuola_id, operazione)
    if (scope.response) return noStore(scope.response)

    const { pagina, limite } = q.data
    const { data, error } = await supabase.rpc('report_cassa_dettaglio', {
      p_scuola_ids: scope.sedi,
      p_tipo: q.data.tipo,
      p_da: q.data.da ?? null,
      p_a: q.data.a ?? null,
      p_categoria: q.data.categoria_id && q.data.categoria_id !== 'senza' ? q.data.categoria_id : null,
      p_senza_categoria: q.data.categoria_id === 'senza',
      p_metodo: q.data.metodo ?? null,
      p_limite: limite,
      p_offset: (pagina - 1) * limite,
    })
    if (error) {
      if (CASSA_SCHEMA_ASSENTE.has(error.code)) {
        logEvento('cassa', 'info', { operazione: 'dettaglio:GET', esito: 'schema-assente', sedi: scope.sedi.length })
        const vuoto: DettaglioCassa = { disponibile: false, righe: [], conteggio: 0, pagina, limite }
        return noStore(NextResponse.json(vuoto))
      }
      logErrore({ operazione, evento: 'db', stato: 500 }, error)
      return noStore(NextResponse.json({ error: 'Errore nella lettura del dettaglio', codice: 'LETTURA_FALLITA' }, { status: 500 }))
    }

    const parsed = rpcSchema.safeParse(data)
    if (!parsed.success) {
      // I dettagli zod possono contenere valori privati: nei log solo la causa tecnica.
      logErrore({ operazione, evento: 'rpc-invalida', stato: 500 }, new Error('Risposta del dettaglio cassa incompleta o non valida'))
      return noStore(NextResponse.json({ error: 'Errore nella lettura del dettaglio', codice: 'LETTURA_FALLITA' }, { status: 500 }))
    }
    const grezzo = parsed.data
    const nomi = await nomiSediCassa(supabase, scope.sedi, operazione)
    const risultato: DettaglioCassa = {
      disponibile: true,
      righe: grezzo.righe.map((riga) => ({ ...riga, scuola_nome: nomi.get(riga.scuola_id) ?? null })),
      conteggio: grezzo.conteggio,
      pagina,
      limite,
      ...(eDirezione(auth.user) ? { totali: { totale: grezzo.totale, contanti: grezzo.contanti, altri: grezzo.altri } } : {}),
    }
    logEvento('cassa', 'info', {
      operazione: 'dettaglio:GET', esito: 'letto', sedi: scope.sedi.length,
      conteggio: grezzo.conteggio, pagina, limite, quantita: risultato.righe.length,
    })
    return noStore(NextResponse.json(risultato))
  } catch (error) {
    logErrore({ operazione, stato: 500 }, error)
    return noStore(NextResponse.json({ error: 'Errore nella lettura del dettaglio', codice: 'LETTURA_FALLITA' }, { status: 500 }))
  }
})
