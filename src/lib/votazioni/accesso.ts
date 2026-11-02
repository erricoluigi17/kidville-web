import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import it from '../../../messages/it/shared.json'
import { requireStaff, type AppUser, type AuthResult } from '@/lib/auth/require-staff'
import { formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { logEvento } from '@/lib/logging/logger'
import { rispostaErroreDbVotazioni } from './errori'
import type { RigaVotazione } from './tipi'

/**
 * VOTAZIONI · CHI PUÒ ENTRARE, E IN QUALE SEDE.
 *
 * Le votazioni dei rappresentanti le gestisce lo staff: Direzione, coordinatori e segreteria, cioè i tre
 * ruoli che `requireStaff` ammette di default (il CRM, che ha il gate più stretto, è un'altra cosa).
 * Modello: `src/lib/crm/accesso.ts`.
 *
 * Il gate di RUOLO (`requireVotazioni`) non basta: tutte le route lavorano col client service-role, che
 * scavalca la RLS. La sede si controlla in applicazione — `caricaVotazioneInScope` per una votazione —
 * con lo stesso criterio del resto del gestionale (`scuoleDiUtente`): la segreteria e i coordinatori hanno
 * la propria sede, la Direzione quelle di `utenti_scuole`.
 */

export const RUOLI_VOTAZIONI = ['admin', 'coordinator', 'segreteria'] as const

/** Il gate di ruolo di tutte le route staff delle votazioni. */
export async function requireVotazioni(request: Request): Promise<AuthResult> {
  return requireStaff(request, RUOLI_VOTAZIONI)
}

const CATALOGO_IT = it as Record<string, string>

/** Le colonne di `RigaVotazione`, nello stesso ordine dell'interfaccia. */
const COLONNE_VOTAZIONE =
  'id, scuola_id, titolo, scadenza, chiusa_il, rappresentante_istituto, creata_da, creata_il, aggiornata_da, aggiornata_il'

/**
 * La votazione esiste ed è di una sede dell'utente? Torna la riga intera, oppure la risposta pronta:
 * 404 `VOTAZIONE_NON_TROVATA` se non c'è, 403 `SEDE_NON_ACCESSIBILE` se è di un'altra sede (la stessa
 * risposta di `rifiutoSede`, con un `warn` persistito: è un segnale di sicurezza).
 *
 * Un guasto di lettura NON è un «non trovata» e nemmeno un «fuori sede»: è 500 (o 503 se le tabelle
 * mancano), con il suo log. Altrimenti un database in difficoltà farebbe sparire le votazioni dalla vista
 * della segreteria con l'aria di un permesso negato.
 *
 * Il diniego non porta né nel corpo né nel log il titolo della votazione altrui.
 */
export async function caricaVotazioneInScope(
  supabase: SupabaseClient,
  user: AppUser,
  votazioneId: string,
): Promise<{ votazione: RigaVotazione } | { response: NextResponse }> {
  const { data, error } = await supabase
    .from('votazioni')
    .select(COLONNE_VOTAZIONE)
    .eq('id', votazioneId)
    .maybeSingle()
  if (error) return { response: rispostaErroreDbVotazioni(error, 'votazioni/accesso:caricaVotazioneInScope') }
  if (!data) {
    return {
      response: NextResponse.json(
        { error: CATALOGO_IT[CODICI_ERRORE.VOTAZIONE_NON_TROVATA], codice: 'VOTAZIONE_NON_TROVATA' },
        { status: 404 },
      ),
    }
  }

  const votazione = data as unknown as RigaVotazione
  const sedi = await scuoleDiUtente(supabase, user)
  if (!sedi.some((s) => formaConfronto(s) === formaConfronto(votazione.scuola_id))) {
    logEvento('multi_sede', 'warn', {
      operazione: 'votazioni/accesso:caricaVotazioneInScope',
      esito: 'votazione-fuori-sede',
      utente: user.id,
      ruolo: user.role,
      sede_id: votazione.scuola_id,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  return { votazione }
}
