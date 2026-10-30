import type { SupabaseClient } from '@supabase/supabase-js'
import { istanteCivile } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'
import { logEvento } from '@/lib/logging/logger'
import { registraEvento } from './eventi'
import { ORA_FOLLOW_UP, type EsitoAzione, type TipoAzione } from './tipi'

/**
 * CRM DELLA SEGRETERIA · LA CATENA DEI FOLLOW-UP.
 *
 * Dopo una visita (o un'assenza) il CRM propone UN richiamo, e dopo ogni richiamo il successivo. È la
 * catena della mini-app di prima più il «recupero» per chi non si è presentato (spec §6):
 *
 *   visita svolta ──► follow_up_1 ──ci pensa──► follow_up_2 ──ci pensa──► ultimatum ■
 *                         │ non risponde            │ non risponde
 *                         ▼                         ▼
 *                     riprova_1 ──────────────► riprova_2 ──► ultimatum ■   (dalla riprova, sempre avanti)
 *   non presentato ──► recupero ──► richiamare ■
 *
 * Ogni passo si riprova UNA volta sola e poi la catena va avanti: con un rinvio infinito al giorno dopo,
 * la lista «da richiamare» non si svuoterebbe mai. `vuole_iscriversi` e `non_interessato` chiudono la
 * catena (si passa all'iscrizione, o si archivia), `ultimatum` e `richiamare` sono l'ultimo anello.
 *
 * Tutte funzioni di GIORNI CIVILI di Roma (`YYYY-MM-DD`): niente `Date` locale, niente fuso scritto a
 * mano. Il calcolo dei giorni è `addGiorni`; l'istante di scadenza è `istanteCivile`, che conosce il
 * cambio dell'ora legale.
 */

export type PassoCatena = TipoAzione | 'visita_svolta' | 'non_presentato'

type Prossima = { tipo: TipoAzione; giorno: string }

/**
 * Il passo che segue `da`, o `null` se la catena finisce. `oggi` e `giornoVisita` sono giorni civili di
 * Roma: la funzione non guarda l'orologio, così si prova senza congelarlo.
 *
 * Un richiamo SENZA esito non produce il passo dopo (`null`): non si inventa che cosa abbia risposto la
 * famiglia.
 */
export function prossimaAzione(i: {
  da: PassoCatena
  esito?: EsitoAzione
  oggi: string
  giornoVisita?: string
}): Prossima | null {
  const fra = (n: number) => addGiorni(i.oggi, n)

  if (i.da === 'visita_svolta') {
    // Due giorni dopo la visita, ma mai nel passato: una visita segnata con giorni di ritardo non deve
    // far nascere un richiamo già scaduto.
    const previsto = addGiorni(i.giornoVisita ?? i.oggi, 2)
    const domani = fra(1)
    return { tipo: 'follow_up_1', giorno: previsto > domani ? previsto : domani }
  }
  if (i.da === 'non_presentato') return { tipo: 'recupero', giorno: fra(1) }

  const { esito } = i
  if (esito !== 'ci_pensa' && esito !== 'non_risponde') return null // chiude la catena, o non è noto

  switch (i.da) {
    case 'follow_up_1':
      return esito === 'ci_pensa' ? { tipo: 'follow_up_2', giorno: fra(3) } : { tipo: 'riprova_1', giorno: fra(1) }
    case 'riprova_1':
      return { tipo: 'follow_up_2', giorno: fra(3) }
    case 'follow_up_2':
      return esito === 'ci_pensa' ? { tipo: 'ultimatum', giorno: fra(3) } : { tipo: 'riprova_2', giorno: fra(1) }
    case 'riprova_2':
      return { tipo: 'ultimatum', giorno: fra(3) }
    case 'recupero':
      return { tipo: 'richiamare', giorno: esito === 'ci_pensa' ? fra(3) : fra(1) }
    default:
      return null // ultimatum, richiamare
  }
}

/**
 * L'istante (ISO UTC) in cui scade un richiamo: le `ora` (di default `ORA_FOLLOW_UP`, le 10:30) del giorno
 * civile `giorno`, lette a Roma. Il 24/10/2026 sono le 08:30Z (ora legale), il 25/10/2026 le 09:30Z
 * (l'ora legale è finita alle 3 di notte).
 *
 * Un giorno che non esiste (`2026-02-30`) è un errore di chi chiama: LANCIA `RangeError` invece di
 * restituire una data inventata. `pianificaAzione` lo intercetta.
 */
export function scadenzaRoma(giorno: string, ora: string = ORA_FOLLOW_UP): string {
  const istante = istanteCivile(giorno, ora)
  if (istante === null) throw new RangeError(`scadenzaRoma: giorno o ora non validi (${giorno} ${ora})`)
  return istante
}

/**
 * Pianifica un richiamo: lo inserisce in `crm_azioni` (scadenza alle 10:30 di Roma del `giorno`) e scrive
 * sullo storico `azione_pianificata`. NON LANCIA MAI: se l'inserimento fallisce (o il giorno non esiste)
 * torna `null` e lo dice nel log (`crm`, error); chi chiama decide se avvisare la segreteria.
 *
 * Se è solo lo STORICO a fallire, l'azione resta pianificata e si torna comunque `{ id }`: `registraEvento`
 * ha già registrato il guasto, e togliere un richiamo vero per un buco nel diario sarebbe peggio.
 */
export async function pianificaAzione(
  supabase: SupabaseClient,
  a: {
    schedaId: string
    scuolaId: string
    tipo: TipoAzione
    giorno: string
    responsabile: string
    appuntamentoId?: string | null
    autore: string | null
  },
): Promise<{ id: string } | null> {
  const campi = { operazione: 'crm/follow-up:pianificaAzione', esito: 'azione-non-pianificata', tipo: a.tipo, scuola_id: a.scuolaId, entita_id: a.schedaId }
  try {
    const scadenza = scadenzaRoma(a.giorno)
    const { data, error } = await supabase
      .from('crm_azioni')
      .insert({
        scuola_id: a.scuolaId,
        scheda_id: a.schedaId,
        tipo: a.tipo,
        scadenza,
        responsabile: a.responsabile,
        appuntamento_id: a.appuntamentoId ?? null,
      })
      .select('id')
      .single()
    if (error || !data) {
      logEvento('crm', 'error', campi, error ?? new Error('inserimento senza riga di ritorno'))
      return null
    }
    const id = data.id as string
    await registraEvento(supabase, {
      schedaId: a.schedaId,
      scuolaId: a.scuolaId,
      tipo: 'azione_pianificata',
      autore: a.autore,
      autoreVia: a.autore ? 'segreteria' : 'sistema',
      dati: { azione_id: id, azione: a.tipo, giorno: a.giorno },
    })
    return { id }
  } catch (err) {
    logEvento('crm', 'error', campi, err)
    return null
  }
}
