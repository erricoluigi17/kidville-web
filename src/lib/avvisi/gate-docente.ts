import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { sezioniDiUtenteConSede } from '@/lib/sezioni/docenti'
import { logEvento } from '@/lib/logging/logger'
import {
  avvisoVisibileAlDocente,
  vedeTuttiGliAvvisi,
  type AvvisoPerVisibilita,
} from '@/lib/avvisi/permessi-docente'

// =============================================================================
// Il dettaglio e le risposte di un avviso li legge solo chi lo vede in bacheca.
//
// Dal 2026-10-07 la bacheca della docente mostra i globali, gli avvisi di almeno
// una sua classe e i propri (`@/lib/avvisi/permessi-docente`). Ma `GET
// /api/avvisi/[id]` e `GET /api/avvisi/[id]/risposte` consegnavano a qualunque
// docente del plesso qualunque avviso — e la seconda anche i NOMI delle famiglie
// di classi non sue. Ciò che la bacheca non mostra, il server non lo consegna per
// un'altra strada.
//
// `null` = consentito. Segreteria e direzione non pagano nessuna lettura in più.
// Il 403 ha un `codice` letterale (lock `errori-con-codice`) e una riga `warn`
// persistita con soli uuid.
// =============================================================================

export async function verificaVisibilitaDocente(
  supabase: SupabaseClient,
  user: AppUser,
  avviso: AvvisoPerVisibilita & { id: string },
  operazione: string,
): Promise<NextResponse | null> {
  if (vedeTuttiGliAvvisi(user)) return null
  const sezioni = await sezioniDiUtenteConSede(supabase, user.id)
  if (avvisoVisibileAlDocente(avviso, { uid: user.id, sezioni })) return null
  logEvento('avvisi', 'warn', {
    operazione,
    esito: 'avviso-fuori-dalle-classi',
    uid: user.id,
    entitaId: avviso.id,
  })
  return NextResponse.json(
    {
      error: 'Questo avviso è indirizzato a classi che non sono le tue.',
      codice: 'AVVISO_FUORI_DALLE_TUE_CLASSI',
    },
    { status: 403 },
  )
}
