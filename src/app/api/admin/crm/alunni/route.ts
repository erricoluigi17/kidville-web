import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

/**
 * CRM della segreteria · la ricerca degli ALUNNI fra cui scegliere quello da collegare a un bambino.
 *
 * `GET /api/admin/crm/alunni?scuolaId=<uuid>&q=<testo>` →
 * `200 { data: [{ id, nome, cognome, data_nascita }] }` — al massimo 20, per cognome e nome.
 *
 * ─── DATI DI MINORI: SI RESTITUISCE IL MINIMO PER SCEGLIERE ──────────────────
 * Esce SOLO ciò che serve a riconoscere un bambino (nome, cognome, data di nascita), mai il resto della scheda
 * (codice fiscale, allergie, note): le colonne si proiettano nella query E si riscrivono a mano nella risposta.
 * Nei log, nemmeno questi: la route non scrive né il testo cercato né i risultati.
 *
 * ─── LA SEDE ─────────────────────────────────────────────────────────────────
 * Si DICHIARA (`scuolaId`, richiesta) e deve stare fra le sedi attive dell'utente (`resolveScuoleAttive` +
 * `restringiSedi`): una sede non propria è un 403, mai un elenco vuoto. `.eq('scuola_id', …)` sta nella STESSA
 * query della ricerca: il collegamento a mano cerca solo alunni di quella sede.
 *
 * ─── SOLO GLI ISCRITTI ───────────────────────────────────────────────────────
 * Si cerca fra chi è iscritto (`STATO_ISCRITTO`, come ogni elenco operativo di sede intera: lo impone il lock
 * `elenchi-operativi-solo-iscritti`). Un alunno ritirato o sospeso non si offre: collegargli un bambino farebbe
 * passare la quota d'iscrizione nella contabilità di chi non frequenta più.
 *
 * ─── IL TESTO ────────────────────────────────────────────────────────────────
 * `q` ha almeno due caratteri DOPO la pulizia. Si tolgono `%`, `,`, `(` e `)` (che nella stringa del filtro
 * `.or()` di PostgREST sono sintassi: una virgola aggiungerebbe una condizione, una parentesi ne chiuderebbe
 * una) e anche `"` e `\`. Un testo fatto di soli caratteri tolti non è una ricerca: è 400, non «tutti gli alunni».
 */

const LIMITE = 20

const pulisci = (q: string) => q.replace(/[%,()"\\]/g, '').trim()

const querySchema = z.object({
  scuolaId: zUuid,
  q: z
    .string()
    .max(100, 'Testo di ricerca troppo lungo')
    .transform(pulisci)
    .pipe(z.string().min(2, 'Scrivi almeno due caratteri')),
})

export const GET = withRoute('admin/crm/alunni:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/alunni:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const testo = q.data.q
  const { data, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, data_nascita')
    .eq('scuola_id', scuole[0])
    .eq('stato', STATO_ISCRITTO)
    .or(`nome.ilike.%${testo}%,cognome.ilike.%${testo}%`)
    .order('cognome', { ascending: true })
    .order('nome', { ascending: true })
    .limit(LIMITE)
  if (error) return rispostaErroreDb(error, 'admin/crm/alunni:GET')

  return NextResponse.json({
    data: (data ?? []).map((a) => ({
      id: a.id as string,
      nome: (a.nome as string | null) ?? null,
      cognome: (a.cognome as string | null) ?? null,
      data_nascita: (a.data_nascita as string | null) ?? null,
    })),
  })
})
