import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { getModuleConfig } from '@/lib/settings/module-config'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { getGenitoriDiAlunni, getGenitoriDiAlunniEsito } from '@/lib/anagrafiche/legami'
import { ritiraNotifichePending } from '@/lib/notifiche/ritira-pending'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { deveNotificareGenitori, oggiRoma, type ContestoNotificaOperazione } from '@/lib/storici/retroattivita'
import { logEvento } from '@/lib/logging/logger'

interface EnqueueParams {
  alunnoIds: string[]
  tipo: string
  titolo: string
  corpo?: string
  link?: string
  entitaTipo?: string
  entitaId?: string
  bufferMin?: number
  /** Scuola per il gate dei toggle; se assente viene risolta dal primo alunno. */
  scuolaId?: string | null
  operazione?: ContestoNotificaOperazione
}

/** Risolve la scuola di un alunno (per il gate dei toggle). Best-effort. */
async function scuolaDiAlunno(supabase: SupabaseClient, alunnoId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.from('alunni').select('scuola_id').eq('id', alunnoId).maybeSingle()
    if (error) {
      logEvento('notifica', 'warn', { operazione: 'scuolaDiAlunno', esito: 'sede-non-letta', alunno_id: alunnoId }, error)
      return null
    }
    return (data?.scuola_id as string | undefined) ?? null
  } catch (err) {
    logEvento('notifica', 'warn', { operazione: 'scuolaDiAlunno', esito: 'sede-non-letta', alunno_id: alunnoId }, err)
    return null
  }
}

/**
 * Crea notifiche in-app (e push, via dispatch) per i genitori degli alunni dati.
 * Con buffer: la notifica diventa inviabile solo dopo `bufferMin` minuti
 * (decisione: tutte le notifiche del registro primaria hanno buffer).
 * Best-effort: gli errori non devono bloccare il flusso chiamante.
 */
export async function enqueueNotifichePerAlunni(
  supabase: SupabaseClient,
  { alunnoIds, tipo, titolo, corpo, link, entitaTipo, entitaId, bufferMin = 10, scuolaId, operazione }: EnqueueParams
): Promise<void> {
  if (!deveNotificareGenitori(operazione)) {
    if (operazione && entitaId) await ritiraPendingPerAlunni(supabase, { alunnoIds, tipo, entitaId, entitaTipo, giorni: [operazione.giornoOriginale ?? operazione.giornoCompetenza], storico: true })
    logEvento('notifica', 'info', { operazione: 'enqueueNotifichePerAlunni', esito: 'rettifica-storica-silenziosa', tipo })
    return
  }
  if (!alunnoIds || alunnoIds.length === 0) return

  // Gate toggle per scuola PRIMA di risolvere i genitori (risparmia la query).
  const scuola = scuolaId !== undefined ? scuolaId : await scuolaDiAlunno(supabase, alunnoIds[0])
  if (!(await isNotificaAbilitata(supabase, tipo, scuola))) return

  // Destinatari sull'UNIONE runtime + anagrafica (`student_parents` via ponte
  // `parents.auth_user_id`). In BLOCCO su tutti gli alunni: 3 query fisse, mai
  // una per bambino — questo percorso serve anche intere sezioni.
  const perAlunno = await getGenitoriDiAlunni(supabase, alunnoIds)
  const genitori = [...new Set([...perAlunno.values()].flat())]
  if (genitori.length === 0) return

  // Delega l'insert al core generico del servizio push (buffer condiviso).
  await enqueueNotifiche(supabase, {
    utenteIds: genitori,
    tipo,
    titolo,
    corpo,
    link,
    entitaTipo,
    entitaId,
    bufferMin,
    operazione,
    destinatario: 'genitore',
  })
}

/**
 * Notifica il genitore di un aggiornamento del Diario 0-6 (P4/DL-040).
 * Buffer 10' = anche **finestra di modifica**: con DEBOUNCE, ogni salvataggio
 * successivo entro i 10' rimuove la notifica diario ancora non inviata per quel
 * figlio e ne ri-accoda una sola → il genitore riceve un'unica notifica con lo
 * stato finale. Best-effort: non blocca il salvataggio del diario.
 */
export async function enqueueDiarioGenitori(
  supabase: SupabaseClient,
  { alunnoId, nome, bufferMin = 10, scuolaId, operazione }: { alunnoId: string; nome?: string | null; bufferMin?: number; scuolaId?: string | null; operazione?: ContestoNotificaOperazione },
): Promise<void> {
  if (!deveNotificareGenitori(operazione)) {
    if (operazione) await ritiraDiarioGenitori(supabase, { alunnoId, giorno: operazione.giornoOriginale ?? operazione.giornoCompetenza, storico: true })
    logEvento('notifica', 'info', { operazione: 'enqueueDiarioGenitori', esito: 'rettifica-storica-silenziosa', alunno_id: alunnoId })
    return
  }
  if (!alunnoId) return
  // Gate toggle per scuola prima del debounce (se disattivata, non tocca la coda).
  const scuola = scuolaId !== undefined ? scuolaId : await scuolaDiAlunno(supabase, alunnoId)
  if (!(await isNotificaAbilitata(supabase, 'diario', scuola))) return
  // Debounce limitato al fatto del giorno: le code di altre giornate restano.
  try {
    // PostgREST NON lancia: il delete fallito tornava in `{ error }` e il catch
    // non scattava. Un debounce che non cancella non rompe niente, ma manda al
    // genitore N notifiche invece di una: va visto, non subìto.
    const riuscita = await ritiraDiarioGenitori(supabase, { alunnoId, giorno: operazione?.giornoOriginale ?? operazione?.giornoCompetenza ?? oggiRoma() })
    if (!riuscita) segnalaDebounceDiarioFallito(alunnoId, new Error('Ritiro diario non completato'))
  } catch (e) {
    segnalaDebounceDiarioFallito(alunnoId, e)
  }
  await enqueueNotifichePerAlunni(supabase, {
    alunnoIds: [alunnoId],
    tipo: 'diario',
    titolo: 'Diario aggiornato',
    corpo: `Nuovo aggiornamento nel diario di ${nome ?? 'tuo figlio'}`,
    // Il diario DI QUEL figlio. Senza link il dispatcher manda `url: '/'`: fino al
    // 2026-09-28 il tocco portava alla home, e con due figli su quello selezionato
    // l'ultima volta. `?id=` è la convenzione di `withIdentity`, e `useParentIdentity`
    // lo rivalida contro i figli veri del genitore.
    link: `/parent/diary?id=${encodeURIComponent(alunnoId)}`,
    entitaTipo: 'diario',
    entitaId: alunnoId,
    bufferMin,
    scuolaId: scuola,
    operazione,
  })
}

async function ritiraPendingPerAlunni(supabase: SupabaseClient, opts: {
  alunnoIds: string[]; tipo: string; entitaId: string; entitaTipo?: string; giorni: string[]; storico?: boolean
}): Promise<boolean> {
  try {
  const legami = await getGenitoriDiAlunniEsito(supabase, opts.alunnoIds)
  if (!legami.completo) {
    logEvento('notifica', 'error', { operazione: 'ritiraPendingPerAlunni', esito: 'ritiro-destinatari-incompleti', tipo: opts.tipo })
    return false
  }
  const utenteIds = [...new Set([...legami.perAlunno.values()].flat())]
  if (!utenteIds.length) return true
  return await ritiraNotifichePending(supabase, { tipo: opts.tipo, entitaId: opts.entitaId, entitaTipo: opts.entitaTipo, utenteIds, giorniOriginali: opts.giorni, storico: opts.storico })
  } catch (errore) {
    logEvento('notifica', 'error', { operazione: 'ritiraPendingPerAlunni', esito: 'ritiro-non-eseguito', tipo: opts.tipo }, errore)
    return false
  }
}

/** Anche la cancellazione storica deve ritirare un avviso precedente al nuovo schema. */
export async function ritiraDiarioGenitori(supabase: SupabaseClient, opts: { alunnoId: string; giorno: string; storico?: boolean }): Promise<boolean> {
  return ritiraPendingPerAlunni(supabase, { alunnoIds: [opts.alunnoId], tipo: 'diario', entitaId: opts.alunnoId, entitaTipo: 'diario', giorni: [opts.giorno], storico: opts.storico })
}

/**
 * Notifica i docenti TITOLARI di una sezione quando una scrittura è stata
 * effettuata da Segreteria/Direzione (non dal titolare stesso). Trasparenza
 * PRD §12. Configurabile per scuola via admin_settings.segreteria_config
 * (notifica_docente, default true). Best-effort: non blocca il flusso.
 */
export async function notificaTitolariScrittura(
  supabase: SupabaseClient,
  opts: {
    attore: AppUser
    sectionId: string
    scuolaId?: string | null
    area: string
    link?: string
  }
): Promise<void> {
  try {
    // Solo per scritture NON del docente titolare (segreteria/direzione/coordinator).
    if (opts.attore.role === 'educator') return

    const scuola = opts.scuolaId ?? opts.attore.scuola_id
    // Doppio gate in AND: il toggle storico segreteria_config.notifica_docente
    // e il nuovo toggle notifiche_config.toggles.segreteria_scrittura.
    const cfg = await getModuleConfig<{ notifica_docente?: boolean }>(
      supabase,
      'segreteria_config',
      scuola,
    )
    if (cfg?.notifica_docente === false) return // default: notifica attiva
    if (!(await isNotificaAbilitata(supabase, 'segreteria_scrittura', scuola))) return

    const titolari = (await docentiDiSezione(supabase, opts.sectionId)).filter((id) => id !== opts.attore.id)
    if (titolari.length === 0) return

    const nome = [opts.attore.nome, opts.attore.cognome].filter(Boolean).join(' ').trim() || 'La Segreteria'
    await enqueueNotifiche(supabase, {
      utenteIds: titolari,
      tipo: 'segreteria_scrittura',
      titolo: `Aggiornamento Segreteria — ${opts.area}`,
      corpo: `${nome} ha aggiornato "${opts.area}" nella tua classe.`,
      link: opts.link ?? null,
      entitaTipo: opts.area,
      bufferMin: 0,
    })
  } catch (e) {
    // `nome` (attore) e `corpo` restano fuori dal log: sono dati personali dello
    // staff. A log vanno l'area toccata e l'esito.
    logEvento(
      'notifica',
      'error',
      {
        operazione: 'notificaTitolariScrittura',
        tipo: 'segreteria_scrittura',
        entita_tipo: opts.area,
        esito: 'notifica-non-accodata',
      },
      e,
    )
  }
}

/** Il nome del figlio (`nome`) NON va a log: a log basta l'uuid dell'alunno. */
function segnalaDebounceDiarioFallito(alunnoId: string, err: unknown): void {
  logEvento(
    'notifica',
    'error',
    {
      operazione: 'enqueueDiarioGenitori:debounce',
      tipo: 'diario',
      esito: 'debounce-fallito',
      alunno_id: alunnoId,
    },
    err,
  )
}
