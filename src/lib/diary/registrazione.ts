/**
 * IL SOLO POSTO CHE RISPONDE ALLA DOMANDA: «QUESTA VOCE VA IN ARCHIVIO / A SCHERMO?»
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ UN DISPATCHER E NON TRE `if`. `nanna.ts` è nato per tre lettori. Oggi i
 * lettori sono CINQUE — chi salva, chi rimette la ✅ riaprendo la schermata, la
 * timeline del genitore, la card «Oggi a scuola» della home, il contatore
 * «Compilato» del cockpit — e le famiglie di evento con una regola sono QUATTRO
 * (umore, nanna, bagno, pasto). Replicare il modello alla lettera significherebbe
 * scrivere un ternario a quattro livelli in cinque file: è la divergenza che
 * `nanna.ts` esiste per impedire, moltiplicata.
 *
 * ⚠️ QUESTA FUNZIONE È FAIL-**OPEN**, ED È IL CONTRARIO DEI MODULI CHE CHIAMA.
 *
 * `bagnoCompilato`, `pastoCompilato` e `nannaCompilata` sono fail-CLOSED: rispondono
 * `false` a un tipo che non è loro, perché nessuno di quei moduli sa niente degli
 * altri. Qui la domanda è diversa — non «è compilato?» ma «questa riga va mostrata?»
 * — e su una famiglia che non ha una regola l'unica risposta accettabile è **sì**.
 *
 * Il precedente è di questo repo e costò caro: un filtro messo per eccesso di zelo
 * fece sparire 29 bambini su 657 dall'alert del pranzo. Un filtro che nel dubbio
 * NASCONDE è il difetto opposto a quello che stiamo chiudendo, e più difficile da
 * accorgersene: una voce che manca non la reclama nessuno.
 *
 * L'INVARIANTE che tiene insieme tutto: `voceDaMostrare` è `false` **se e solo se**
 * la narrativa del genitore non avrebbe nessuna riga vera da dire e cadrebbe sulla
 * frase generica. Il filtro non nasconde «le righe brutte»: impedisce che una voce
 * venga raccontata con una frase falsa. Da qui discende che `bagnoGenerico`,
 * `pastoGenerico` e `nannaGenerica` RESTANO nel catalogo: sono la rete, non la
 * strada.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import { eEventoNanna, nannaCompilata } from '@/lib/diary/nanna';
import { umoreFromDettagli } from '@/lib/diary/umore';
import { eEventoBagno, bagnoCompilato } from '@/lib/diary/bagno';
import { eEventoPasto, pastoCompilato } from '@/lib/diary/pasto';

/**
 * I tipi evento che si salvano SOLO a chi li ha davvero.
 *
 * `attivita` non c'è, e non è una dimenticanza: la descrizione di un'attività è di
 * CLASSE per progetto — «oggi pittura, tema autunno» è vero per tutti — e l'unica
 * cosa per bambino, la partecipazione, può legittimamente restare vuota per un
 * bambino che c'era. Filtrarla farebbe sparire dal diario di tutti un'attività
 * realmente svolta: sarebbe l'errore dei 29 bambini, rifatto.
 */
export const TIPI_SELETTIVI: readonly string[] = [
    'umore', 'nanna', 'nanna_inizio', 'nanna_fine', 'bagno', 'pranzo', 'merenda',
];

/** Questo tipo evento si salva solo a chi lo ha davvero? */
export function eventoSelettivo(tipo: string): boolean {
    return TIPI_SELETTIVI.includes(tipo);
}

/**
 * Questa voce va salvata / mostrata?
 *
 * Un solo posto per i cinque lettori. Fail-open su ciò che non ha una regola.
 */
export function voceDaMostrare(
    tipo: string,
    dettagli: Record<string, unknown> | null | undefined,
    opts?: { conNota?: boolean },
): boolean {
    // UNA NOTA È CONTENUTO, E DA SOLA TIENE IN PIEDI LA VOCE.
    //
    // Scoperto da un test che esisteva già (`diary-nota-bambino-hook`): una maestra
    // che apre «Pranzo», non segna nessuna portata e scrive «oggi era un po'
    // stanca» ha comunicato qualcosa. Col solo filtro sui `dettagli` quella frase
    // sparirebbe in silenzio al salvataggio — e in lettura la voce che la contiene
    // verrebbe nascosta, perché il genitore la legge DENTRO la tessera dell'evento.
    // Sarebbe una perdita di dato introdotta da una correzione che nasce per
    // impedirne un'altra.
    //
    // Vale sia per la nota di sezione (che va a tutti, quindi tiene in piedi la
    // voce di tutti) sia per quella del singolo bambino.
    if (opts?.conNota) return true;
    if (tipo === 'umore') return umoreFromDettagli(dettagli) !== null;
    if (eEventoNanna(tipo)) return nannaCompilata(tipo, dettagli);
    if (eEventoBagno(tipo)) return bagnoCompilato(tipo, dettagli);
    if (eEventoPasto(tipo)) return pastoCompilato(tipo, dettagli);
    return true;
}

/**
 * I tipi evento che si possono CANCELLARE quando sono stati segnati per errore.
 *
 * PERCHÉ SERVE, ed è la conseguenza diretta del salvataggio selettivo. Con il
 * filtro, «azzera i contatori e risalva» non cancella niente: quel bambino esce
 * dal payload, la POST parte senza di lui o non parte affatto, e la riga resta in
 * archivio esattamente com'era. A schermo però i contatori sono a zero, la ✅ è
 * sparita e il toast è verde: un no-op che SEMBRA riuscito.
 *
 * Per il bagno è peggio che per la nanna, e per un motivo preciso: la riga
 * sbagliata NON è vuota — porta `{pipi:2, cacca:1}` — quindi il filtro di lettura
 * non la rende inerte, e il genitore continua a leggere «Ho fatto pipì 2 volte»
 * del figlio di un altro. Per sempre.
 *
 * ⚠️ `umore` NON è qui, ed è una decisione, non una dimenticanza. Un umore
 * sbagliato si corregge SCEGLIENDONE UN ALTRO, che è un update vero e riesce.
 * L'unico caso irreparabile è «volevo toglierlo del tutto», che degrada al banner
 * d'attesa — non a una frase falsa nel diario di un bambino. Resta un buco noto,
 * e sta scritto qui perché si veda.
 *
 * `attivita` non è qui perché non è selettivo: si salva a tutti e non ha la
 * trappola del no-op.
 */
export const TIPI_ELIMINABILI: readonly string[] = [
    'nanna_inizio', 'nanna_fine', 'bagno', 'pranzo', 'merenda',
];

/** Questa registrazione si può cancellare dalla schermata del docente? */
export function eliminabile(tipo: string): boolean {
    return TIPI_ELIMINABILI.includes(tipo);
}
