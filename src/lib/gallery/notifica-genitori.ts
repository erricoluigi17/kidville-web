// =============================================================================
// L'AVVISO ALLE FAMIGLIE QUANDO UN CONTENUTO ENTRA IN GALLERIA — in UN posto solo.
//
// PERCHÉ ESISTE (PR 2 video, 2026-10-02).
// L'avviso stava dentro l'handler `POST /api/gallery`, scritto per le foto. Ora anche
// un video, quando la conversione finisce, deve annunciarsi alle famiglie: la
// pubblicazione dei video gira sul server (`pubblicaVideoGalleria`), senza nessuna
// richiesta dell'insegnante in mezzo. Stessa funzione, stesse regole, stesso testo.
//
// ─── IL TESTO NON NOMINA MAI NIENTE ─────────────────────────────────────────────
// Titolo «Nuovi contenuti in galleria» e corpo «Ci sono nuovi contenuti nella
// galleria.» sono costanti: la funzione non riceve né una didascalia né il nome di un
// file, quindi non può metterli nel messaggio. Fino al 2026-10-02 il corpo era la
// didascalia fra virgolette, e la didascalia di una foto è il nome del file scelto da
// chi carica — «Marco al parco.jpg»: il nome di un bambino, sulla schermata di blocco
// di tutti i genitori taggati. La decisione del titolare è: nessuna didascalia per i
// contenuti nuovi, e un avviso che non dice niente di chi c'è.
//
// ─── CHI RICEVE, IN ORDINE ─────────────────────────────────────────────────────
// I genitori dei bambini taggati; altrimenti quelli delle classi bersaglio; altrimenti
// quelli di tutta la sede. È la regola di sempre: il broadcast di una sede intera
// arriva qui come «nessun tag e nessuna classe».
//
// ─── COME SI COLLASSA LA RAFFICA ───────────────────────────────────────────────
// `entitaId = uploadedBy` (l'INSEGNANTE, non il media), `bufferMin: 30`, `debounce:
// true`: dieci foto di fila diventano un solo avviso per famiglia. Il debounce di
// `notificaEvento` cancella le notifiche pending dello stesso tipo e della stessa
// entità SOLO per i destinatari di questa chiamata (#131): senza quel filtro ogni
// foto cancellava gli avvisi generati dalle precedenti per famiglie che non
// c'entravano, e il 7-8 settembre ne sono andati persi 168 su 298.
//
// ─── MAI UN'ECCEZIONE VERSO CHI CHIAMA ──────────────────────────────────────────
// L'avviso è best-effort: il contenuto è già pubblicato, e un guasto qui non deve
// trasformare in errore una pubblicazione riuscita. Ma non è mai muto: se la
// preparazione dell'avviso fallisce si logga a livello `error` (il contenuto è salvo,
// il suo annuncio è perso, e nessuno se ne accorgerebbe senza quella riga) e la
// funzione risponde `null`. Chi chiama, a differenza del `catch` di prima, il numero
// dei destinatari lo riceve: «due bambini nella foto, zero famiglie avvisate» è un
// guasto vivo (in produzione ci sono alunni senza nessun tutore collegato) e va
// scritto nel log di successo accanto al contenuto.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { notificaEvento } from '@/lib/notifiche/triggers'

export const TITOLO_NOTIFICA_GENITORI_GALLERIA = 'Nuovi contenuti in galleria'
export const CORPO_NOTIFICA_GENITORI_GALLERIA = 'Ci sono nuovi contenuti nella galleria.'
/** Quanto attende l'avviso prima della push: la raffica di un'insegnante collassa in uno solo. */
export const MINUTI_BUFFER_NOTIFICA_GENITORI_GALLERIA = 30

/**
 * Accoda l'avviso alle famiglie di un contenuto appena pubblicato.
 *
 * @param input.scuolaId la sede DEL CONTENUTO (decide il toggle e i destinatari di classe/sede).
 * @param input.uploadedBy chi ha caricato: è la chiave del debounce, quindi dev'essere sempre lo stesso uuid per la raffica.
 * @param input.tagAlunni i bambini ritratti. Per un video, quelli EFFETTIVI: chi è uscito dalla sede non deve essere avvisato.
 * @param input.classi le classi bersaglio, usate solo se non c'è nessun bambino.
 * @param input.operazione chi sta chiamando, per ritrovare la riga in `app_log`.
 * @returns quante famiglie sono state raggiunte (anche 0), o `null` se la preparazione dell'avviso è fallita.
 */
export async function notificaGenitoriGalleria(
  supabase: SupabaseClient,
  input: {
    scuolaId: string
    uploadedBy: string
    tagAlunni: readonly string[] | null | undefined
    classi: readonly string[] | null | undefined
    operazione: string
  },
): Promise<number | null> {
  try {
    const tagged = [...(input.tagAlunni ?? [])]
    const classi = Array.isArray(input.classi) ? input.classi.filter(Boolean) : []
    const destinatari =
      tagged.length > 0
        ? await genitoriDiAlunni(supabase, tagged)
        : classi.length > 0
          ? await genitoriDiClassi(supabase, input.scuolaId, classi)
          : await genitoriDiScuola(supabase, input.scuolaId)
    await notificaEvento(supabase, {
      tipo: 'galleria',
      scuolaId: input.scuolaId,
      utenteIds: destinatari,
      titolo: TITOLO_NOTIFICA_GENITORI_GALLERIA,
      corpo: CORPO_NOTIFICA_GENITORI_GALLERIA,
      link: '/parent/gallery',
      entitaTipo: 'galleria',
      entitaId: input.uploadedBy,
      bufferMin: MINUTI_BUFFER_NOTIFICA_GENITORI_GALLERIA,
      debounce: true,
    })
    return destinatari.length
  } catch (e) {
    // `error` benché il contenuto sia pubblicato: l'avviso non è mai stato accodato,
    // quindi le famiglie non sapranno dei contenuti nuovi. Il contenuto è salvo, il suo
    // annuncio è perso — e senza questa riga nessuno se ne accorgerebbe.
    logEvento('notifica', 'error', {
      operazione: input.operazione,
      esito: 'notifica-genitori-non-accodata',
    }, e)
    return null
  }
}
