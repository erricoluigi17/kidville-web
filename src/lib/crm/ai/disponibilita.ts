import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextResponse } from 'next/server'
import { personeDellaSede } from '@/lib/crm/accesso'
import { rispostaCrmNonRiuscita, rispostaErroreDb, tabellaAssente } from '@/lib/crm/errori'
import { caricaFasceEffettive } from '@/lib/crm/settimane'
import { calcolaSlotLiberi, type SlotLibero } from '@/lib/crm/slot'
import type { AppuntamentoRow, IndisponibilitaRow } from '@/lib/crm/tipi'
import { inizioGiornoCivile } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'
import { logErrore } from '@/lib/logging/logger'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { validationError } from '@/lib/validation/http'
import type { Grado } from './eta'

export const ANTICIPO_MINIMO_MIN = 120
export const GIORNI_MAX_AI = 31
export const SLOT_MAX_AI = 60

export interface AgendaAi {
  liberi: SlotLibero[]
  /** La stessa griglia senza le visite, per distinguere un orario occupato da uno fuori disponibilità. */
  inFascia: SlotLibero[]
}

function erroreLettura(errore: unknown, operazione: string): { response: NextResponse } {
  const tecnico = erroreDbSoloCodice(errore)
  if (tabellaAssente(tecnico)) return { response: rispostaErroreDb(tecnico, operazione) }
  logErrore({ operazione, stato: 500 }, tecnico)
  return { response: rispostaCrmNonRiuscita() }
}

/** Legge una sola sede e aggiunge l'anticipo minimo all'istante passato dal chiamante. */
export async function caricaAgendaAi(
  supabase: SupabaseClient, scuolaId: string, dal: string, al: string, adesso: Date, operazione: string,
): Promise<AgendaAi | { response: NextResponse }> {
  const da = inizioGiornoCivile(dal)
  const a = inizioGiornoCivile(addGiorni(al, 1))
  if (da === null || a === null) {
    return { response: validationError([{ path: ['dal'], message: 'Intervallo non valido' }]) }
  }

  let visite, assenze
  try {
    [visite, assenze] = await Promise.all([
      supabase.from('crm_appuntamenti').select('assegnata_a, inizio, fine, stato')
        .eq('scuola_id', scuolaId).eq('stato', 'in_programma').lt('inizio', a).gt('fine', da),
      supabase.from('crm_indisponibilita').select('*')
        .eq('scuola_id', scuolaId).lt('dal', a).gt('al', da),
    ])
  } catch (errore) {
    return erroreLettura(errore, operazione + ':agenda')
  }
  if (visite.error) return erroreLettura(visite.error, operazione + ':appuntamenti')
  if (assenze.error) return erroreLettura(assenze.error, operazione + ':indisponibilita')

  let fasce
  try {
    fasce = await caricaFasceEffettive(supabase, scuolaId, dal, al)
  } catch (errore) {
    return erroreLettura(errore, operazione + ':disponibilita')
  }
  let persone
  try {
    persone = await personeDellaSede(supabase, scuolaId, { rigoroso: true })
  } catch (errore) {
    return erroreLettura(errore, operazione + ':persone')
  }

  const dellaSede = new Set(persone.map((p) => p.id))
  const comune = {
    fasce: fasce.filter((f) => f.utenteId === null || dellaSede.has(f.utenteId)),
    persone: [...dellaSede],
    indisponibilita: (assenze.data ?? []) as IndisponibilitaRow[],
    dal,
    al,
    adesso: new Date(adesso.getTime() + ANTICIPO_MINIMO_MIN * 60_000),
  }
  const appuntamenti = (visite.data ?? []) as Pick<AppuntamentoRow, 'assegnata_a' | 'inizio' | 'fine' | 'stato'>[]
  return {
    liberi: calcolaSlotLiberi({ ...comune, appuntamenti }),
    inFascia: calcolaSlotLiberi({ ...comune, appuntamenti: [] }),
  }
}

/** Gli orari pubblici conservano soltanto gli estremi ISO UTC. */
export function orariPerAssistente(liberi: SlotLibero[]): { inizio: string; fine: string }[] {
  const unici = new Map<string, { inizio: string; fine: string }>()
  for (const { inizio, fine } of liberi) unici.set(`${inizio}|${fine}`, { inizio, fine })
  return [...unici.values()].sort((a, b) => a.inizio.localeCompare(b.inizio) || a.fine.localeCompare(b.fine))
}

/** Privilegia le persone con una propria fascia, poi chi è libero nella fascia della sede. */
export function candidatiPer(
  liberi: SlotLibero[], inizioIso: string,
): { candidati: string[]; durataMin: number; fine: string } | null {
  const inizio = Date.parse(inizioIso)
  const allInizio = liberi.filter((s) => Date.parse(s.inizio) === inizio)
  const primo = allInizio[0]
  if (!primo) return null
  const fine = Date.parse(primo.fine)
  const dellaPersona: string[] = []
  const dellaSede: string[] = []
  for (const slot of allInizio) {
    if (Date.parse(slot.fine) !== fine) continue
    if (slot.utenteId !== null) dellaPersona.push(slot.utenteId)
    else dellaSede.push(...(slot.personeLibere ?? []))
  }
  return { candidati: [...new Set([...dellaPersona, ...dellaSede])], durataMin: (fine - inizio) / 60_000, fine: primo.fine }
}

export async function sedeCopre(
  supabase: SupabaseClient, scuolaId: string, gradi: Grado[], operazione: string,
): Promise<{ coperta: boolean } | { response: NextResponse }> {
  if (gradi.length === 0) return { coperta: false }
  try {
    const { data, error } = await supabase.from('sections').select('id').eq('scuola_id', scuolaId).in('school_type', gradi).limit(1)
    if (error) return erroreLettura(error, operazione + ':sezioni')
    return { coperta: (data?.length ?? 0) > 0 }
  } catch (errore) {
    return erroreLettura(errore, operazione + ':sezioni')
  }
}
