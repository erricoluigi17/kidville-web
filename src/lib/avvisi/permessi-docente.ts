/* ════════════════════════════════════════════════════════════════════════════
 * CHI VEDE UN AVVISO, E CHI PUÒ MODIFICARLO — una regola sola, in un posto solo.
 *
 * Decisione del titolare del 2026-10-07:
 *
 *                      VEDE                              MODIFICA / ELIMINA
 *   segreteria,        tutti gli avvisi della sede       tutti
 *   direzione
 *   docente            per tutta la sede · di almeno     SOLO i propri
 *                      UNA sua classe · scritti da lei
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Un avviso della segreteria per DUE classi «è comparso a tutta la scuola». Le
 * famiglie giuste lo avevano ricevuto (misurato in produzione: zero notifiche e
 * zero risposte fuori target) — lo vedevano invece TUTTE le docenti del plesso,
 * perché il ramo staff di `GET /api/avvisi` filtrava solo per sede. E la stessa
 * bacheca offriva «Modifica» ed «Elimina» su qualunque avviso: una docente poteva
 * cancellare quello della segreteria e il server rispondeva 200.
 *
 * ─── QUI NIENTE I/O ─────────────────────────────────────────────────────────
 *
 * Le due funzioni le usano la lista (per filtrare e per il booleano
 * `modificabile`), il dettaglio, le risposte, il PUT e il DELETE. Una regola che
 * ciascuna strada si riscrivesse in casa divergerebbe alla prima modifica: è il
 * difetto che questo repository ha già pagato più volte sugli avvisi.
 *
 * `haUnRuolo` viene dal modulo PURO `predicati-ruolo`, non da `require-staff`
 * (che ~300 test sostituiscono per intero con un mock).
 * ════════════════════════════════════════════════════════════════════════════ */

import { haUnRuolo, type AppUser, type StaffRole } from '@/lib/auth/predicati-ruolo'

/**
 * Il gruppo «Segreteria e Direzione»: vede tutto e modifica tutto.
 *
 * È lo stesso insieme che decide il gruppo di PUBBLICAZIONE in
 * `POST /api/avvisi` (la pillola «Segreteria/Admin» di Impostazioni → Avvisi):
 * un insieme solo, importato da lì.
 */
export const RUOLI_GESTIONE_AVVISI: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']

/**
 * Segreteria o direzione: vede TUTTI gli avvisi delle proprie sedi.
 *
 * Sui ruoli REALI. Nel ramo staff di `GET /api/avvisi` coincide con
 * `vedeTutteLeClassi` (`@/lib/auth/scope`), perché una persona ha un solo ruolo
 * staff: sta qui, nel modulo puro, perché `@/lib/auth/scope` lo sostituiscono per
 * intero decine di test, e una funzione nuova presa da lì li farebbe esplodere con
 * `No "…" export is defined on the mock`.
 */
export function vedeTuttiGliAvvisi(user: AppUser): boolean {
  return haUnRuolo(user, RUOLI_GESTIONE_AVVISI)
}

/**
 * AUTORIZZAZIONE: può modificare o eliminare QUESTO avviso?
 *
 * Sui ruoli REALI (`haUnRuolo`), non sulla veste del cookie: una docente che
 * guarda l'app come genitore resta una docente, e non diventa segreteria.
 * Autore ignoto ⇒ no: un avviso che non si sa di chi sia non lo tocca chi non
 * è gestione.
 */
export function puoGestireAvviso(user: AppUser, authorId: string | null | undefined): boolean {
  if (vedeTuttiGliAvvisi(user)) return true
  return !!authorId && authorId === user.id
}

/** Una classe assegnata alla docente, CON la sua sede: il nome da solo non è una chiave. */
export interface SezioneConSede {
  nome: string
  scuola_id: string | null
}

/** I soli campi della riga che servono a decidere. */
export interface AvvisoPerVisibilita {
  author_id?: string | null
  target_scope?: string | null
  target_classes?: readonly string[] | null
  scuola_id?: string | null
}

/**
 * PRESENTAZIONE PER LA DOCENTE: questo avviso le spetta?
 *
 * - per tutta la sede → sì (la lista è già ristretta alle sue sedi);
 * - scritto da lei → sì, anche se nel frattempo la classe non è più sua;
 * - di classe → sì se almeno UNA delle classi destinatarie è sua NELLA STESSA
 *   SEDE dell'avviso. Il nome di una sezione non è unico fra i plessi («2 ANNI»
 *   esiste in due sedi): senza la sede, l'avviso di Aversa comparirebbe alla
 *   docente omonima di Giugliano.
 *
 * Fail-closed: senza sezioni, o con un avviso di classe senza sede, restano solo
 * i globali e i propri.
 */
export function avvisoVisibileAlDocente(
  avviso: AvvisoPerVisibilita,
  docente: { uid: string; sezioni: readonly SezioneConSede[] },
): boolean {
  if (avviso.target_scope === 'globale') return true
  if (avviso.author_id && avviso.author_id === docente.uid) return true
  if (!avviso.scuola_id) return false
  const proprie = new Set(
    docente.sezioni
      .filter((s) => s.scuola_id === avviso.scuola_id)
      .map((s) => s.nome),
  )
  return (avviso.target_classes ?? []).some((c) => proprie.has(c))
}
