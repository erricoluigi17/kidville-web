import type { NextResponse } from 'next/server'
import { NextResponse as Risposta } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireStaff, type AppUser, type AuthResult } from '@/lib/auth/require-staff'
import { formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { logEvento } from '@/lib/logging/logger'
import { rispostaErroreDb } from './errori'

/**
 * CRM DELLA SEGRETERIA · CHI PUÒ ENTRARE, E IN QUALE SEDE.
 *
 * Il CRM è della segreteria e della Direzione. Il coordinatore NON c'è (è il ruolo che il resto del
 * gestionale ammette quasi ovunque): le schede contengono i recapiti e le abitudini di famiglie che non
 * sono ancora iscritte, e il gate è quello che il titolare ha chiesto.
 *
 * Il gate di RUOLO (`requireCrm`) non basta: tutte le route lavorano col client service-role, che
 * scavalca la RLS. La sede si controlla in applicazione — `assertSchedaInScope` per una scheda,
 * `assertPersonaInScope` per la persona a cui si assegna una visita — con lo stesso criterio del resto
 * del gestionale (`scuoleDiUtente`): la segreteria ha la propria sede, la Direzione quelle di
 * `utenti_scuole`.
 */

export const RUOLI_CRM = ['segreteria', 'admin'] as const

/** Il gate di ruolo di tutte le route del CRM. */
export async function requireCrm(request: Request): Promise<AuthResult> {
  return requireStaff(request, RUOLI_CRM)
}

/**
 * La scheda esiste ed è di una sede dell'utente? Torna la scheda (id e sede), oppure la risposta pronta:
 * 404 `SCHEDA_NON_TROVATA` se non c'è, 403 `SEDE_NON_ACCESSIBILE` se è di un'altra sede.
 *
 * Un guasto di lettura NON è un «non trovata»: è 500 (o 503 se le tabelle mancano), con il suo log.
 */
export async function assertSchedaInScope(
  supabase: SupabaseClient,
  user: AppUser,
  schedaId: string,
): Promise<{ scheda: { id: string; scuola_id: string } } | { response: NextResponse }> {
  const { data, error } = await supabase.from('crm_schede').select('id, scuola_id').eq('id', schedaId).maybeSingle()
  if (error) return { response: rispostaErroreDb(error, 'crm/accesso:assertSchedaInScope') }
  if (!data) {
    return {
      response: Risposta.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 }),
    }
  }
  const scheda = { id: data.id as string, scuola_id: data.scuola_id as string }
  const sedi = await scuoleDiUtente(supabase, user)
  if (!sedi.some((s) => formaConfronto(s) === formaConfronto(scheda.scuola_id))) {
    logEvento('multi_sede', 'warn', {
      operazione: 'crm/accesso:assertSchedaInScope',
      esito: 'scheda-fuori-sede',
      utente: user.id,
      ruolo: user.role,
      sede_id: scheda.scuola_id,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  return { scheda }
}

const PERSONA_NON_DELLA_SEDE = () =>
  Risposta.json(
    { error: 'La persona scelta non fa parte di questa sede.', codice: 'PERSONA_NON_DELLA_SEDE' },
    { status: 422 },
  )

/**
 * A questa persona si può assegnare una visita in questa sede? `null` se sì. Altrimenti 422
 * `PERSONA_NON_DELLA_SEDE`, per qualunque motivo: non esiste, non è segreteria né Direzione, è
 * archiviata, o non ha quella sede (la propria `scuola_id`, oppure — solo la Direzione — `utenti_scuole`).
 * La risposta è la stessa in tutti i casi: non si dice a chi chiede quali uuid esistono.
 */
export async function assertPersonaInScope(
  supabase: SupabaseClient,
  utenteId: string,
  scuolaId: string,
): Promise<NextResponse | null> {
  const { data, error } = await supabase
    .from('utenti')
    .select('id, ruolo, scuola_id, archiviato_il')
    .eq('id', utenteId)
    .maybeSingle()
  if (error) return rispostaErroreDb(error, 'crm/accesso:assertPersonaInScope')
  if (!data) return PERSONA_NON_DELLA_SEDE()
  const ruolo = data.ruolo as string | null
  if (data.archiviato_il != null || !ruolo || !(RUOLI_CRM as readonly string[]).includes(ruolo)) {
    return PERSONA_NON_DELLA_SEDE()
  }
  const sedi = await scuoleDiUtente(supabase, {
    id: data.id as string,
    role: ruolo as AppUser['role'],
    scuola_id: (data.scuola_id as string | null) ?? null,
  })
  return sedi.some((s) => formaConfronto(s) === formaConfronto(scuolaId)) ? null : PERSONA_NON_DELLA_SEDE()
}

export type PersonaCrm = { id: string; nome: string; cognome: string; ruolo: 'segreteria' | 'admin' }

/**
 * Le persone a cui in questa sede si può assegnare una visita: segreteria e Direzione non archiviate che
 * hanno la sede. Per cognome e nome.
 *
 * ⚠️ «CHI HA QUESTA SEDE» NON SI CHIEDE ALLA SOLA COLONNA `utenti.scuola_id`: è la query che nelle sedi
 * aperte il 2026-07-29 dava un elenco VUOTO, in silenzio (lock `destinatari-con-ponte`). L'unione fra
 * sede primaria e ponte `utenti_scuole` la fa `staffScuola`, l'unico punto del repo autorizzato; qui si
 * rilegge soltanto chi è tornato (nome, archiviazione) e si applica la regola di `scuoleDiUtente`: la
 * sede ottenuta dal ponte vale **solo per la Direzione**. `staffScuola` accetta il ponte per qualunque
 * ruolo (serve a notificare), e senza questo filtro una segreteria presente per errore nel ponte
 * comparirebbe nell'elenco e poi si prenderebbe 422 da `assertPersonaInScope`.
 *
 * Un guasto nella rilettura finale LANCIA (l'errore di PostgREST, tale e quale): un `[]` direbbe alla
 * schermata «nessuno è disponibile». Un guasto DENTRO `staffScuola` no: lì l'errore si registra (area
 * `notifica`) e l'elenco esce vuoto o parziale — perciò un elenco vuoto lascia una riga `warn` anche
 * qui, nell'area `crm`.
 */
export async function personeDellaSede(supabase: SupabaseClient, scuolaId: string): Promise<PersonaCrm[]> {
  const ids = await staffScuola(supabase, scuolaId, [...RUOLI_CRM])
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('utenti')
      .select('id, nome, cognome, ruolo, scuola_id')
      .in('id', ids)
      .in('ruolo', [...RUOLI_CRM])
      .is('archiviato_il', null)
    if (error) throw error

    const persone = (data ?? [])
      .filter(
        (r) =>
          r.ruolo === 'admin' ||
          (typeof r.scuola_id === 'string' && formaConfronto(r.scuola_id) === formaConfronto(scuolaId)),
      )
      .map((r) => ({
        id: r.id as string,
        nome: (r.nome as string | null) ?? '',
        cognome: (r.cognome as string | null) ?? '',
        ruolo: r.ruolo as 'segreteria' | 'admin',
      }))
      .sort((a, b) => a.cognome.localeCompare(b.cognome, 'it') || a.nome.localeCompare(b.nome, 'it'))
    if (persone.length > 0) return persone
  }
  logEvento('crm', 'warn', { operazione: 'crm/accesso:personeDellaSede', esito: 'nessuna-persona-nella-sede', sede_id: scuolaId })
  return []
}
