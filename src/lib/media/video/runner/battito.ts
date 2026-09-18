import { logEvento } from '@/lib/logging/logger'

import type { ComandoInCorso, EsitoBattito, EsitoComando } from './porte'

/**
 * IL BATTITO — per quanto tempo un job resta nostro, e come si smette.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL CONTO, e da dove viene ciascun numero
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * La firma di `video_job_claim(p_job_id, p_lease_owner, p_lease_seconds)` accetta
 * 1–1800 secondi, e a occhio sembrerebbe quello il tetto. NON LO È.
 * `video_job_heartbeat` non prende nessun `p_lease_seconds`: rinnova sempre a
 * `clock_timestamp() + interval '5 minutes'`
 * (`20260916190100_video_job_transitions.sql`). Quindi il tetto vero — quello dentro
 * cui il battito successivo deve arrivare — è **300 secondi**, qualunque cosa si sia
 * chiesta al momento della presa in carico. Chi tarasse il ritmo sul 1800 della
 * firma vedrebbe la lease scadere sotto i piedi con il worker ancora vivo, e un
 * secondo worker riscattare un job che era già in lavorazione.
 *
 * Il test `video-runner-battito.test.ts` rilegge quell'`interval '5 minutes'` dalla
 * migrazione: se un giorno la RPC cambia, il numero qui sotto diventa rosso invece
 * di diventare falso in silenzio.
 *
 *   tetto della lease                       300 s
 *   periodo del battito       300 / 5   =    60 s
 *   occasioni utili prima della scadenza     4   (a 60, 120, 180, 240 s;
 *                                                 quella a 300 arriva tardi)
 *   battiti consecutivi che si possono perdere  4
 *
 * Cinque finestre e non due o venti: con un periodo di 150 s un solo contrattempo
 * di rete perderebbe la lease; con uno di 10 s si pagherebbero trenta andate e
 * ritorno al database per ogni conversione, su un canale dove il volume atteso è di
 * 26 video al giorno e il costo non è il problema — il rumore nei log sì.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PERCHÉ SI SONDA PIÙ SPESSO DI QUANTO SI BATTA
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Sono due domande diverse e hanno due ritmi diversi: «la lease è ancora mia?» ogni
 * 60 secondi, «la conversione è finita?» ogni 10. Se coincidessero, una conversione
 * finita un istante dopo un battito resterebbe scoperta fino al battito successivo:
 * fino a un minuto in cui il video è pronto, il Sandbox è acceso e si paga, e un
 * genitore guarda una barra che non si muove.
 */

/** Quanto rinnova un battito, misurato su `video_job_heartbeat`. Non è configurabile. */
export const SECONDI_LEASE_BATTITO = 300

/**
 * Quanto si chiede alla presa in carico. Uguale a ciò che un battito rinnova: due
 * numeri diversi vorrebbero dire che il primo giro ha una regola sua, e il primo
 * giro è proprio quello in cui la MicroVM si sta ancora accendendo.
 */
export const SECONDI_LEASE_PRESA = 300

export const PERIODO_BATTITO_MS = 60_000
export const PERIODO_SONDA_MS = 10_000

/** Quattro: le occasioni dentro la lease meno quella che cade sull'istante di scadenza. */
export const BATTITI_TOLLERATI =
  Math.floor((SECONDI_LEASE_BATTITO * 1000) / PERIODO_BATTITO_MS) - 1

/**
 * Il tetto assoluto della MicroVM: si passa a `Sandbox.create({ timeout })` e a
 * spegnerla è la PIATTAFORMA, non questo codice.
 *
 * 30 minuti. La misura peggiore del piano (2026-09-17, rumore sintetico da 2,13 GB
 * convertito a 2 thread) è di **709 secondi di wall**; su 4 vCPU in `dub1` il caso
 * tipico sta fra 212 e 353 secondi. Il tetto vale 2,5 volte il peggio misurato, e
 * ci stanno dentro anche lo scarico dell'originale e il caricamento dell'uscita.
 *
 * Esiste perché un `ffmpeg` che non finisce mai è un conto che non finisce mai: la
 * fatturazione del Sandbox è a `GB × ore` e nessuno se ne accorgerebbe guardando i
 * log, dove quel job semplicemente non comparirebbe più. E sta sulla piattaforma
 * invece che nel nostro ciclo per la ragione che regge tutto questo modulo: il
 * nostro ciclo muore con l'invocazione, il `timeout` del Sandbox no.
 */
export const TETTO_SANDBOX_MS = 1_800_000

/**
 * Quanto sorveglia UNA invocazione, prima di andarsene lasciando il lavoro acceso.
 *
 * 240 secondi, contro i 300 che una funzione Vercel può durare al massimo (le route
 * più pesanti di questo repo dichiarano `maxDuration = 300`). I 60 secondi di
 * margine non sono prudenza generica: dentro ci stanno l'apertura del Sandbox,
 * l'apparecchio, l'eventuale scrittura dell'esito su `video_job_ready` e la
 * risposta HTTP. Una sorveglianza che consumasse l'intera invocazione verrebbe
 * tagliata **dopo** che la conversione è finita e **prima** di averla scritta: il
 * lavoro pagato e l'esito perso.
 *
 * Il patto con il cron: finché un tick parte entro `SECONDI_LEASE_BATTITO` secondi
 * dall'ultimo battito, la catena non si spezza e la conversione prosegue di
 * invocazione in invocazione. Se si spezza — un rilascio, un guasto — la lease
 * scade, il job torna in coda con un fence nuovo e la conversione si rifà da capo.
 * È il modo giusto in cui sbagliare: si spreca tempo di CPU, non si perde un video.
 */
export const TETTO_INVOCAZIONE_MS = 240_000

export type EsitoSorveglianza =
  | { esito: 'finito'; comando: EsitoComando; battiti: number }
  | { esito: 'lease-persa'; codice: string; battiti: number }
  | { esito: 'in-corso'; battiti: number }

export interface SorveglianzaConversione {
  comando: ComandoInCorso
  battito: () => Promise<EsitoBattito>
  adesso: () => number
  pausa: (ms: number) => Promise<void>
  /** Il tetto di QUESTA invocazione. Oltre, si lascia tutto acceso e si torna dopo. */
  tettoInvocazioneMs: number
}

/**
 * Tiene viva la lease finché la conversione gira, e decide quando smettere.
 *
 * ─── I DUE SILENZI DEL BATTITO, che non sono la stessa cosa ──────────────────
 *
 * Un battito può andare storto in due modi opposti, e confonderli costa in
 * entrambe le direzioni:
 *
 *  · **Il database ha risposto di NO** (`FENCE_MISMATCH`, `LEASE_MISMATCH`,
 *    `INVALID_STATE`). È un verdetto: il job è di qualcun altro, o è già chiuso.
 *    Non c'è niente da ritentare — insistere significherebbe due `ffmpeg` sullo
 *    stesso file e due esiti che si contendono la stessa riga. Si spegne subito.
 *
 *  · **Il battito non è partito** (rete giù, timeout, 503). Non è un verdetto: è
 *    l'assenza di una risposta. Se si trattasse questo come il primo, un singhiozzo
 *    di rete butterebbe via una conversione a metà — e la lease, che dura ancora
 *    240 secondi, sarebbe stata sprecata per niente. Si tollera, e si conta: dopo
 *    `BATTITI_TOLLERATI` tentativi consecutivi a vuoto la lease è scaduta per
 *    aritmetica, non per ipotesi, e continuare a macinare è tempo di CPU pagato per
 *    un'uscita che `video_job_ready` rifiuterà con `FENCE_MISMATCH`.
 *
 * È la stessa distinzione fra «segnale assente» e «segnale falso» che questo
 * repository paga ogni volta che la dimentica.
 *
 * ─── E UN COMANDO CHE ESCE MALE È COMUNQUE «FINITO» ──────────────────────────
 *
 * Un `exitCode` diverso da zero non è affar suo: la sorveglianza sorveglia, non
 * giudica. È chi ha chiamato a sapere se 137 significa «tetto di tempo di ffmpeg» o
 * «la MicroVM è stata spenta», e a scegliere il codice d'errore giusto.
 */
export async function sorvegliaConversione(p: SorveglianzaConversione): Promise<EsitoSorveglianza> {
  const inizio = p.adesso()
  let ultimoBattito = inizio
  let battiti = 0
  let persiConsecutivi = 0

  for (;;) {
    const comando = await p.comando.esito()
    if (comando !== null) return { esito: 'finito', comando, battiti }

    // ⚠️ QUI NON SI SPEGNE NIENTE, ed è il contrario di ciò che verrebbe da fare.
    // Il tetto dell'invocazione non dice «la conversione è troppo lunga»: dice «io
    // devo andare». La MicroVM resta accesa, la lease resta viva ancora qualche
    // minuto, e il tick successivo la riaggancia per nome e riprende a sorvegliare.
    // Fermare il comando qui vorrebbe dire buttare via ogni conversione che dura
    // più di quattro minuti — cioè quasi tutte.
    if (p.adesso() - inizio >= p.tettoInvocazioneMs) return { esito: 'in-corso', battiti }

    if (p.adesso() - ultimoBattito >= PERIODO_BATTITO_MS) {
      ultimoBattito = p.adesso()
      let esitoBattito: EsitoBattito | null = null
      try {
        esitoBattito = await p.battito()
      } catch (err) {
        // Un catch che non logga è un bug: qui il battito perso è l'unica traccia
        // che resta di una lease che sta morendo mentre la conversione va avanti.
        // `warn` e non `error`: il primo battito perso non è un guasto, il quarto sì
        // — e quello esce dal ramo `persiConsecutivi` con il suo codice.
        persiConsecutivi += 1
        logEvento(
          'cron',
          'warn',
          { operazione: 'video-runner:battito', esito: 'battito-non-partito', persiConsecutivi },
          err,
        )
        if (persiConsecutivi >= BATTITI_TOLLERATI) {
          await fermaComando(p.comando)
          return { esito: 'lease-persa', codice: 'LEASE_EXPIRED', battiti }
        }
      }

      if (esitoBattito !== null) {
        if (!esitoBattito.ok) {
          await fermaComando(p.comando)
          return { esito: 'lease-persa', codice: esitoBattito.code, battiti }
        }
        battiti += 1
        persiConsecutivi = 0
      }
    }

    await p.pausa(PERIODO_SONDA_MS)
  }
}

/**
 * Spegne il comando senza poter fallire.
 *
 * Il `kill` è già la reazione a qualcosa che è andato storto: se anche lui va
 * storto, l'unica cosa peggiore di non spegnere il comando è perdere il motivo per
 * cui lo si stava spegnendo. Si logga e si prosegue — chi ha chiamato deve poter
 * scrivere l'esito vero sul database, che è la cosa che conta di più.
 */
async function fermaComando(comando: ComandoInCorso): Promise<void> {
  try {
    await comando.termina()
  } catch (err) {
    logEvento(
      'cron',
      'error',
      { operazione: 'video-runner:battito', esito: 'comando-non-terminato' },
      err,
    )
  }
}
