import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { dataCivile, intlDateTime } from '@/i18n/config'
import type { AppUser } from '@/lib/auth/require-staff'
import { formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { FORMA_DATA_ORA_LOCALE, inizioGiornoCivile, istanteDaLocale } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'
import { formatData } from '@/lib/i18n/date'
import { logEvento } from '@/lib/logging/logger'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { zDataOraLocale, zDataYMD } from '@/lib/validation/common'
import { rispostaErroreDb } from './errori'
import { caricaFasceEffettive, type FasciaEffettiva } from './settimane'
import { fuoriDisponibilita } from './slot'
import { DURATA_SLOT_DEFAULT_MIN, type IndisponibilitaRow } from './tipi'

/**
 * CRM DELLA SEGRETERIA · L'AGENDA: quello che le route di visite, disponibilità e assenze si dividono.
 *
 * Sta qui, e non dentro una `route.ts`, perché Next vieta a un file di route di esportare altro che i
 * metodi HTTP, e più di una route ha bisogno della stessa regola.
 */

// ── L'orario sul filo ────────────────────────────────────────────────────────────

/**
 * Un orario che arriva dal client, in una di DUE forme:
 *  · `YYYY-MM-DDTHH:MM` — le cifre che la persona ha letto sull'orologio a muro (è ciò che mandano le
 *    schermate: il browser non conosce il fuso dell'applicazione, e un ISO costruito da lui porta
 *    l'orologio del tablet). Il server le ancora a Roma con `istanteDaLocale`;
 *  · un ISO con offset (`2026-10-25T09:00:00Z`) — l'istante di uno slot restituito dall'agenda, e la forma
 *    che userà l'interfaccia per l'assistente AI.
 */
export const zOrarioVisita = z.union([zDataOraLocale, z.iso.datetime({ offset: true })], {
  error: 'Data e ora non valide (atteso YYYY-MM-DDTHH:MM oppure un istante ISO)',
})

/** L'istante ISO UTC di un orario del filo, o `null` se non si lascia leggere. */
export function istanteDaOrario(orario: string): string | null {
  if (FORMA_DATA_ORA_LOCALE.test(orario)) return istanteDaLocale(orario)
  const ms = Date.parse(orario)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

const FORMA_GIORNO = /^\d{4}-\d{2}-\d{2}$/

/**
 * Un estremo di un'ASSENZA (ferie, malattia, chiusura): un GIORNO intero (`2026-11-03`) oppure un orario
 * preciso (le stesse due forme di `zOrarioVisita`). Le ferie si dicono a giorni — «dal 3 al 5 novembre» — e
 * la schermata non deve fare l'aritmetica del «giorno dopo»: la fa il server, in giorni di Roma.
 */
export const zEstremoAssenza = z.union([zDataYMD, zOrarioVisita], {
  error: 'Data non valida (atteso YYYY-MM-DD, oppure YYYY-MM-DDTHH:MM)',
})

/**
 * L'istante ISO UTC di un estremo d'assenza. Un giorno intero è letto come un INTERVALLO: «dal» comincia
 * a mezzanotte di quel giorno, «al» finisce a mezzanotte del giorno DOPO, così l'ultimo giorno è compreso
 * (la colonna `al` è l'estremo escluso, come in ogni intervallo semiaperto del CRM).
 */
export function istanteEstremoAssenza(valore: string, estremo: 'dal' | 'al'): string | null {
  if (FORMA_GIORNO.test(valore)) return inizioGiornoCivile(estremo === 'dal' ? valore : addGiorni(valore, 1))
  return istanteDaOrario(valore)
}

/** `inizio + durata`, in tempo reale: la stessa aritmetica del vincolo EXCLUDE del database. */
export function fineDaDurata(inizio: string, durataMin: number): string {
  return new Date(Date.parse(inizio) + durataMin * 60_000).toISOString()
}

/** La durata di una visita: come il `CHECK` di `crm_appuntamenti.durata_min`. */
export const zDurataVisitaMin = z.number().int().min(15).max(240)
export const DURATA_VISITA_DEFAULT_MIN = DURATA_SLOT_DEFAULT_MIN

// ── Chi può toccare cosa ─────────────────────────────────────────────────────────

/**
 * La disponibilità e le assenze sono di una PERSONA: ognuna modifica le proprie, l'admin quelle di tutte
 * (spec §9). Una segreteria che tocca quelle di una collega prende 403 `SOLO_LA_PROPRIA`.
 */
export function puoToccareDi(user: AppUser, utenteId: string): boolean {
  return user.role === 'admin' || user.id === utenteId
}

export const soloLaPropria = () =>
  NextResponse.json(
    { error: 'Puoi modificare solo la tua disponibilità. Per le altre persone serve la Direzione.', codice: 'SOLO_LA_PROPRIA' },
    { status: 403 },
  )

/** 404 di una visita, di una fascia o di un'assenza che non c'è più (codice dichiarato in `CODICI_ERRORE`). */
export const elementoNonTrovato = () =>
  NextResponse.json({ error: 'Elemento non trovato.', codice: 'ELEMENTO_NON_TROVATO' }, { status: 404 })

/**
 * La sede di una RIGA già letta (una fascia di disponibilità, un'assenza) è fra quelle dell'utente?
 * `null` se sì; altrimenti 403 `SEDE_NON_ACCESSIBILE`. Stesso criterio di `assertSchedaInScope`
 * (`scuoleDiUtente`): la segreteria ha la propria sede, la Direzione quelle di `utenti_scuole`.
 */
export async function assertSedeInScope(
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  operazione: string,
): Promise<NextResponse | null> {
  const sedi = await scuoleDiUtente(supabase, user)
  if (sedi.some((s) => formaConfronto(s) === formaConfronto(scuolaId))) return null
  logEvento('multi_sede', 'warn', {
    operazione,
    esito: 'riga-fuori-sede',
    utente: user.id,
    ruolo: user.role,
    sede_id: scuolaId,
  })
  return rifiutoSede('SEDE_NON_ACCESSIBILE')
}

// ── «Fuori disponibilità» ────────────────────────────────────────────────────────

/**
 * Questa visita cade fuori dalla disponibilità? Legge le fasce della settimana di quel giorno (della persona e
 * della sede: `caricaFasceEffettive` risolve «una settimana mai toccata è uguale alla precedente»), le assenze
 * che toccano la visita (della persona e di tutta la sede) e decide con `fuoriDisponibilita`. Una visita sta
 * dentro se sta per intero in una fascia della sua persona OPPURE della sede.
 *
 * Un guasto di lettura NON diventa «dentro»: torna la risposta d'errore (500, o 503 se le tabelle
 * mancano), perché un avviso che tace per un guasto direbbe alla segretaria «tutto a posto» quando non lo sa.
 */
export async function visitaFuoriDisponibilita(
  supabase: SupabaseClient,
  v: { scuolaId: string; utenteId: string; inizio: string; fine: string; operazione: string },
): Promise<{ fuori: boolean } | { response: NextResponse }> {
  const giorno = dataCivile(new Date(v.inizio))

  let fasce: FasciaEffettiva[]
  try {
    fasce = await caricaFasceEffettive(supabase, v.scuolaId, giorno, giorno)
  } catch (err) {
    return { response: rispostaErroreDb(err as { code?: string; message?: string }, `${v.operazione}:disponibilita`) }
  }

  const ass = await supabase
    .from('crm_indisponibilita')
    .select('*')
    .eq('scuola_id', v.scuolaId)
    .or(`utente_id.is.null,utente_id.eq.${v.utenteId}`)
    .lt('dal', v.fine)
    .gt('al', v.inizio)
  if (ass.error) return { response: rispostaErroreDb(ass.error, `${v.operazione}:indisponibilita`) }

  return {
    fuori: fuoriDisponibilita(
      { assegnata_a: v.utenteId, inizio: v.inizio, fine: v.fine },
      fasce,
      (ass.data ?? []) as IndisponibilitaRow[],
    ),
  }
}

// ── La notifica ──────────────────────────────────────────────────────────────────

/**
 * Il testo della notifica «visita assegnata»: SOLO giorno e ora.
 *
 * ⚠️ Titolo e corpo compaiono sul telefono BLOCCATO, in chiaro, davanti a chi sta accanto: il nome della
 * famiglia (o di un bambino) non ci entra mai, nemmeno «per comodità». Per questo la funzione riceve
 * soltanto l'istante: non ha modo di sapere come si chiama nessuno. Il testo di una notifica persistita
 * non si traduce (vedi `src/lib/notifiche/tipi.ts`): è in italiano.
 */
export function testoNotificaVisita(inizio: string): { titolo: string; corpo: string } {
  const giorno = intlDateTime('it', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(inizio))
  const ora = formatData(inizio, 'it', 'ora')
  return { titolo: 'Visita assegnata a te', corpo: `${giorno}, ore ${ora}` }
}

/**
 * Avvisa la segretaria a cui è stata assegnata (o riassegnata) una visita. A TENTATIVO: la visita è già
 * fissata, e una notifica che non parte non la annulla — `notificaEvento` non lancia, e se lo facesse lo
 * si registra qui invece di trasformare un 201 in un 500.
 */
export async function notificaVisitaAssegnata(
  supabase: SupabaseClient,
  v: { scuolaId: string; appuntamentoId: string; inizio: string; destinatario: string },
): Promise<void> {
  const { titolo, corpo } = testoNotificaVisita(v.inizio)
  try {
    await notificaEvento(supabase, {
      tipo: 'crm_visita_assegnata',
      scuolaId: v.scuolaId,
      utenteIds: [v.destinatario],
      destinatario: 'personale',
      titolo,
      corpo,
      link: '/admin/crm?tab=agenda',
      entitaTipo: 'crm_appuntamento',
      entitaId: v.appuntamentoId,
      bufferMin: 0,
    })
  } catch (err) {
    logEvento(
      'crm',
      'error',
      { operazione: 'crm/agenda:notificaVisitaAssegnata', esito: 'notifica-non-inviata', scuola_id: v.scuolaId, entita_id: v.appuntamentoId },
      err,
    )
  }
}
