/**
 * La password da consegnare, anche quando l'account esiste già.
 *
 * ─── IL DIFETTO CHE QUESTO FILE CHIUDE ──────────────────────────────────────
 * `ensureParentIdentity` restituisce `password` **solo** quando ha appena creato
 * l'account (`src/lib/auth/parent-identity.ts:473`): è giusto così, perché una
 * password non si può rileggere da `auth.users` — esiste solo l'impronta.
 *
 * Va benissimo finché chi chiama crea l'account e manda l'email nello stesso
 * respiro. Smette di funzionare nel momento in cui i due gesti si separano, ed è
 * esattamente ciò che succede in un lavoro che gira ogni mattina: al primo giro
 * l'account nasce e la password c'è; se l'email non parte, il giro dopo trova
 * l'account già esistente, `createdAuth` vale `false`, `password` vale `null` —
 * e non c'è più niente da mandare. L'invito resterebbe appeso per sempre,
 * bruciando i tre tentativi fino a «bloccata», con il primo giro andato bene e
 * nessun errore che spieghi perché.
 *
 * ─── PERCHÉ STA QUI E NON DENTRO LA ROUTE ───────────────────────────────────
 * Il gesto — genera una password nuova e scrivila sull'account — esisteva già,
 * in `src/app/api/admin/regenerate-credentials/route.ts`. Copiarlo avrebbe
 * creato la seconda copia di una regola che tocca gli accessi delle famiglie: in
 * questo repository quella lezione è già scritta due volte (`parent-identity.ts:112`,
 * `staff-identity.ts:336`) e ogni volta è costata un guasto silenzioso.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { randomPassword } from './parent-identity'

export type EsitoPassword =
  | { ok: true; password: string }
  | { ok: false; motivo: string }

/**
 * Genera una password nuova e la scrive sull'account indicato.
 *
 * Da usare SOLO quando c'è davvero da consegnarla: ogni chiamata invalida la
 * precedente, quindi chiamarla «per sicurezza» su un account già in uso
 * spegnerebbe l'accesso di chi si era già collegato.
 *
 * @param operazione il nome di chi chiama, per il log (mai dati personali)
 */
export async function rigeneraPasswordPerInvito(
  admin: SupabaseClient,
  authUserId: string,
  operazione: string,
): Promise<EsitoPassword> {
  const password = randomPassword()
  const { error } = await admin.auth.admin.updateUserById(authUserId, {
    password,
    email_confirm: true,
  })

  if (error) {
    // Non si logga né l'email né la password: solo l'uuid dell'account, che passa
    // in chiaro per forma (redact.ts) ed è quanto basta a ritrovare il caso.
    logEvento(
      'auth',
      'error',
      {
        operazione,
        esito: 'password-non-riscritta',
        entita_id: authUserId,
      },
      error,
    )
    return { ok: false, motivo: `Password non riscritta sull'account: ${error.message}` }
  }

  return { ok: true, password }
}
