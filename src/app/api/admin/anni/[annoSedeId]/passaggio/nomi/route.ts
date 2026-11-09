import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { leggiNomiDelPassaggio } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * I NOMI DELLE RIGHE DEL PASSAGGIO (giro di correzione 1, S20). La pagina mostra uuid e deve stampare un nome: prima lo cercava
 * scaricando tre elenchi interi di `admin/students` (`limit=1000`), cioè anche codici fiscali e note mediche di centinaia di bambini
 * per leggerne dieci. Qui escono SOLO nome, cognome e classe, e solo dei bambini che hanno una riga in QUESTO passaggio.
 *
 * `?ids=uuid,uuid,…` (da 1 a 200). Il passaggio lo trova il SERVER dall'anno dell'URL, già dentro il perimetro dell'utente. Un uuid
 * che non è una riga del passaggio non compare nella risposta (nessun errore: non si dice che esiste). Nei log: mai un nome.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const querySchema = z.object({
  ids: z
    .string()
    .min(1)
    .max(200 * 37)
    .transform((s) => s.split(',').filter((x) => x.length > 0))
    .pipe(z.array(zUuid).min(1).max(200)),
})

export const GET = withRoute('admin/anni/[annoSedeId]/passaggio/nomi:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/nomi:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  const { ids } = q.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true }

  const passaggio = await passaggioDellAnno(supabase, annoSedeId, ctx)
  if ('response' in passaggio) return passaggio.response

  // Solo i bambini che hanno una riga in questo passaggio: lo garantisce la porta, che è l'unica a leggere le tabelle del passaggio.
  const letti = await leggiNomiDelPassaggio(supabase, passaggio.passaggioId, ids)
  if (!letti.ok || 'saltata' in letti) return rispostaPassaggioNonRiuscito(letti, ctx)
  return NextResponse.json({ success: true, data: letti.nomi })
})
