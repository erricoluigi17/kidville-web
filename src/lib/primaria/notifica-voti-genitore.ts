import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * LE NOTIFICHE DELLA PAGINA VOTI PORTANO AL FIGLIO GIUSTO.
 *
 * Fino al 2026-09-30 il link era `/parent/primaria/valutazioni` e basta: la
 * pagina apriva il figlio selezionato l'ultima volta (`kv_student_id`), e con
 * due figli il tocco su «Nuova valutazione» poteva mostrare «Nessuna
 * valutazione» — quelle dell'ALTRO bambino. Misurato quel giorno: 34 account
 * genitore su 65, fra quelli dei bambini valutati, hanno più di un figlio.
 *
 * Il diario era stato corretto il 28/09 con la stessa convenzione
 * (`/parent/diary?id=…`, `@/lib/primaria/notifiche`): `?id=` lo legge
 * `useParentIdentity`, che lo RIVALIDA contro i figli veri del genitore — un id
 * che non è suo figlio non apre niente.
 *
 * Vive in un modulo suo, e non in `notifiche.ts`, per una ragione di test: i
 * test delle route sostituiscono `notifiche.ts` per intero, e un helper messo lì
 * sarebbe arrivato alle route come il finto, non come il codice vero.
 */
export function linkVotiGenitore(alunnoId: string): string {
  return `/parent/primaria/valutazioni?id=${encodeURIComponent(alunnoId)}`
}

/**
 * Il NOME del bambino (mai il cognome) per il titolo della notifica: con due
 * figli, «Nuova valutazione di Matematica» non dice di chi. È lo stesso
 * perimetro della notifica del diario («Nuovo aggiornamento nel diario di …»).
 *
 * Fail-open: una lettura fallita non ferma la notifica, che parte senza nome.
 * Ma lascia una riga `warn` — PostgREST non lancia, e un `{ error }` ignorato
 * qui sarebbe un titolo senza nome senza che nessuno sappia perché.
 */
export async function nomeAlunnoPerNotifica(
  supabase: SupabaseClient,
  alunnoId: string,
  operazione: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.from('alunni').select('nome').eq('id', alunnoId).maybeSingle()
    if (error) {
      logEvento('notifica', 'warn', { operazione, esito: 'nome-alunno-non-letto', alunno_id: alunnoId }, error)
      return null
    }
    const nome = (data as { nome?: unknown } | null)?.nome
    return typeof nome === 'string' && nome.trim() ? nome.trim() : null
  } catch (e) {
    logEvento('notifica', 'warn', { operazione, esito: 'nome-alunno-non-letto', alunno_id: alunnoId }, e)
    return null
  }
}
