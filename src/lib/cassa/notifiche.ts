import type { SupabaseClient } from '@supabase/supabase-js'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { getModuleConfig } from '@/lib/settings/module-config'
import { logEvento } from '@/lib/logging/logger'
import { formatEuro } from '@/lib/format/valuta'
import { caricaSaldoCassa } from './saldo'
import { metodoLabel, type CassaConfig } from './tipi'

// =============================================================================
// MODULO CASSA · notifiche agli admin (contratto §3.3).
//
// Due eventi (catalogo TIPI_NOTIFICA, gruppo staff — registrati da E2):
//   · cassa_uscita  — uscita registrata da un membro dello staff NON admin
//   · cassa_soglia  — contante atteso oltre la soglia configurata (transizione
//                     sotto→sopra soglia soltanto; flag anti-spam in cassa_config)
//
// Entrambe best-effort: non lanciano MAI verso la route. Titolo/corpo SENZA
// testo libero — solo importi formattati (repo pubblico, dati di minori).
// =============================================================================

/** Tipi notifica (le chiavi che E2 registra in TIPI_NOTIFICA). */
export const TIPO_CASSA_SOGLIA = 'cassa_soglia'
export const TIPO_CASSA_USCITA = 'cassa_uscita'

const LINK_CASSA = '/admin/pagamenti?vista=cassa'
const COLONNA_CONFIG_ASSENTE = new Set(['PGRST204', 'PGRST205', '42703', '42P01'])

// La valuta passa dalla fonte unica dell'app. La versione precedente formattava
// a mano con `toLocaleString('it-IT', { minimumFractionDigits: 2 })`: sembra
// corretta e non lo è, perché l'it-IT ha `minimumGroupingDigits = 2` e per i
// numeri a quattro cifre NON raggruppa — una soglia di 1500 arrivava all'admin
// come «1500,00 €» mentre il pannello Cassa, a un clic, diceva «€ 1.500,00».
const euro = (n: number): string => formatEuro(n)

/**
 * Id degli admin della sede. DUE livelli, dal più preciso al meno preciso:
 *
 *   1. mappatura `utenti_scuole` per la sede, se ha righe per questi admin;
 *   2. altrimenti gli admin la cui colonna `utenti.scuola_id` è la sede richiesta
 *      (l'appartenenza a una sede è l'unione delle due fonti, non la sola colonna).
 *
 * NESSUN TERZO LIVELLO. Fino al 2026-07-31 c'era: «nessuna mappatura ⇒ TUTTI gli
 * admin del sistema», con un log `info`. Con una sede sola «meglio una notifica in
 * più» era difendibile; con tre plessi significa la cassa di Aversa annunciata
 * all'amministratore di Giugliano — e `info` è precisamente il livello che NON
 * viene persistito (`EVENTI_PERSISTITI` tiene warn ed error), quindi quel degrado
 * non lasciava nemmeno una riga interrogabile. Zero destinatari con un avviso è
 * onesto; «tutti» è una decisione di visibilità presa da un ramo di ripiego.
 *
 * Non lancia mai.
 */
export async function adminDellaSede(supabase: SupabaseClient, scuolaId: string): Promise<string[]> {
  try {
    const { data: admins, error } = await supabase.from('utenti').select('id, scuola_id').eq('ruolo', 'admin')
    if (error) {
      logEvento('cassa', 'warn', { operazione: 'adminDellaSede', esito: 'admin-non-letti' }, error)
      return []
    }
    const righe = (admins ?? []) as { id: string; scuola_id: string | null }[]
    const ids = righe.map((a) => String(a.id))
    if (ids.length === 0) return []

    // Livello 2 (fallback intermedio): calcolato in anticipo, serve in due rami.
    const perColonna = righe.filter((a) => a.scuola_id === scuolaId).map((a) => String(a.id))

    const { data: us, error: eUs } = await supabase
      .from('utenti_scuole')
      .select('utente_id')
      .eq('scuola_id', scuolaId)
      .in('utente_id', ids)
    if (eUs) {
      // Tabella multi-plesso assente/illeggibile: prova la colonna diretta prima di
      // rinunciare. `warn` e non `info`: il ponte illeggibile è un guasto, e da qui in
      // poi la rinuncia è silenziosa per chiunque non legga i log.
      if (perColonna.length > 0) return perColonna
      logEvento('cassa', 'warn', {
        operazione: 'adminDellaSede', esito: 'utenti-scuole-non-letta', sede_id: scuolaId,
      }, eUs)
      return []
    }
    const perSede = (us ?? []).map((r) => String((r as { utente_id: string }).utente_id))
    if (perSede.length > 0) return perSede
    if (perColonna.length > 0) return perColonna
    // Nessuna mappatura per-sede né per-colonna: si NEGA e lo si dice. Prima si
    // notificavano tutti gli admin del sistema con una riga `info` non persistita.
    logEvento('cassa', 'warn', {
      operazione: 'adminDellaSede', esito: 'nessun-destinatario', sede_id: scuolaId, n: ids.length,
    })
    return []
  } catch (e) {
    logEvento('cassa', 'error', { operazione: 'adminDellaSede', esito: 'errore' }, e)
    return []
  }
}

/**
 * Best-effort, non lancia mai. Notifica gli admin di un'uscita registrata da
 * non-admin. Nessun testo libero: solo importo e metodo.
 */
export async function notificaUscitaNonAdmin(
  supabase: SupabaseClient,
  args: { scuolaId: string; movimentoId: string; importo: number; metodo: string },
): Promise<void> {
  try {
    const utenteIds = await adminDellaSede(supabase, args.scuolaId)
    if (utenteIds.length === 0) return
    await notificaEvento(supabase, {
      tipo: TIPO_CASSA_USCITA,
      scuolaId: args.scuolaId,
      utenteIds,
      titolo: 'Uscita di cassa registrata',
      corpo: `Registrata un'uscita di ${euro(args.importo)} (${metodoLabel(args.metodo)}) dalla segreteria.`,
      link: LINK_CASSA,
      entitaTipo: 'cassa_movimento',
      entitaId: args.movimentoId,
      debounce: true,
    })
  } catch (e) {
    // La route risponde comunque 201: qui il silenzio è vietato (AGENTS regola 6).
    logEvento('cassa', 'error', { operazione: 'notificaUscitaNonAdmin', esito: 'notifica-non-inviata' }, e)
  }
}

/**
 * Best-effort, non lancia mai. Legge cassa_config, ricalcola il saldo, notifica
 * gli admin SOLO alla transizione sotto→sopra soglia (flag soglia_notificata_il
 * in cassa_config; reset quando il saldo torna ≤ soglia). No-op se soglia_avviso
 * assente o schema assente.
 */
export async function verificaSogliaCassa(supabase: SupabaseClient, scuolaId: string): Promise<void> {
  try {
    const config = await getModuleConfig<CassaConfig>(supabase, 'cassa_config', scuolaId)
    const soglia = config.soglia_avviso
    if (soglia == null) return // nessuna soglia configurata → niente da fare

    const fondo = config.fondo ?? 0
    const saldo = await caricaSaldoCassa(supabase, scuolaId, fondo)
    if (!saldo.disponibile) return // schema assente

    const sopra = saldo.saldo_atteso > soglia
    const giaNotificato = !!config.soglia_notificata_il

    if (sopra && !giaNotificato) {
      const utenteIds = await adminDellaSede(supabase, scuolaId)
      if (utenteIds.length > 0) {
        await notificaEvento(supabase, {
          tipo: TIPO_CASSA_SOGLIA,
          scuolaId,
          utenteIds,
          titolo: 'Soglia contante superata',
          corpo: `Il contante atteso in cassa (${euro(saldo.saldo_atteso)}) ha superato la soglia di ${euro(soglia)}.`,
          link: LINK_CASSA,
          entitaTipo: 'cassa_config',
          entitaId: scuolaId,
          debounce: true,
        })
      }
      await impostaFlagSoglia(supabase, scuolaId, config, new Date().toISOString())
    } else if (!sopra && giaNotificato) {
      // Rientrata sotto soglia: azzera il flag così la prossima salita rinotifica.
      await impostaFlagSoglia(supabase, scuolaId, config, null)
    }
  } catch (e) {
    logEvento('cassa', 'error', { operazione: 'verificaSogliaCassa', esito: 'verifica-fallita' }, e)
  }
}

/** Scrive soglia_notificata_il preservando le altre chiavi note della config. */
async function impostaFlagSoglia(
  supabase: SupabaseClient,
  scuolaId: string,
  config: Partial<CassaConfig>,
  valore: string | null,
): Promise<void> {
  const nuova: CassaConfig = {
    fondo: config.fondo,
    soglia_avviso: config.soglia_avviso ?? null,
    soglia_notificata_il: valore,
  }
  const { error } = await supabase.from('admin_settings').update({ cassa_config: nuova }).eq('scuola_id', scuolaId)
  if (error) {
    const code = (error as { code?: string }).code ?? ''
    if (COLONNA_CONFIG_ASSENTE.has(code)) return // DB non migrato: niente flag, niente incidente
    logEvento('cassa', 'warn', { operazione: 'verificaSogliaCassa', esito: 'flag-non-salvato' }, error)
  }
}
