'use client';

import type { ReactNode } from 'react';

/**
 * IL PIEDE DELL'AZIONE — il comando «Comunica assenza» e tutto ciò che parla di lui.
 *
 * ─── I DUE BLOCCANTI CHE QUESTO COMPONENTE CHIUDE ───────────────────────────
 * La barra di navigazione del genitore (`BottomNav`) è `fixed bottom-0` con
 * `z-50`: sta SOPRA il contenuto, e occupa `--kv-bottomnav-h` in fondo allo
 * schermo. Chi deve restarle fuori deve saperlo.
 *
 *  · 2026-08-07 — su `/parent/attendance` il pulsante primario cadeva dentro
 *    quella fascia (137px di sovrapposizione su 145) e `adb shell input tap` sul
 *    suo centro apriva /parent/avvisi. Rimedio: un ricovero `sticky` ancorato a
 *    `--kv-bottomnav-h`. Misura dopo: 49/49 tocchi a segno.
 *  · 2026-08-08 — **lo stesso difetto era ancora intero sulla card della
 *    primaria**, che è l'altra porta della stessa funzione: pulsante coperto al
 *    100%, e `page.mouse.click(112, 823)` portava il genitore nel Diario. La
 *    lezione era stata scritta in un commento del file gemello invece che in un
 *    componente. Ora è qui, e la usano tutte e due.
 *  · 2026-08-08 — e il rimedio del 07/08 ne aveva aperto un terzo: il piede
 *    copriva il messaggio di RIFIUTO che il piede stesso genera (100% su iPhone
 *    14/15/15 Pro) e la riga che spiega perché il comando è spento.
 *
 * ─── PERCHÉ I MESSAGGI STANNO DENTRO, E NON SOTTO ───────────────────────────
 * L'alternativa era dichiarare al browser lo spazio occupato con
 * `scroll-margin-bottom`, così che `focus()` scrollasse davvero. Non basta, e la
 * ragione è misurabile: `focus()` porta in vista **solo chi riceve il fuoco**, e
 * la riga di stato del comando il fuoco non lo riceve mai — è la sua
 * descrizione, non un ricovero. Sarebbe rimasta coperta esattamente com'era.
 *
 * Dentro il piede, invece, non esiste stato del mondo in cui un messaggio
 * dell'azione finisca sotto qualcosa: il piede è la cosa più in basso che ci sia,
 * e ciò che sta dentro di lui sta sopra la barra. La regola che ne segue, e che
 * il lock blocca: **tutto ciò che parla dell'AZIONE vive nel piede dell'azione;
 * ciò che parla di un CAMPO sta sopra quel campo.**
 *
 * ─── ANATOMIA, E PERCHÉ NON È SOLO IL BOTTONE ───────────────────────────────
 * `sticky` e non `fixed`: appena la sua posizione naturale risale sopra la linea
 * della barra, il piede torna nel flusso e non copre più niente.
 * `z-40` e non di più: sotto la barra, mai sopra — coprire la navigazione
 * sarebbe lo stesso difetto al contrario.
 * Una SUPERFICIE opaca (che ogni schermata dichiara in `className`, perché
 * dipende dalla card che lo ospita): senza, ciò che passa sotto viene coperto
 * a metà parola dal solo riempimento del bottone. Il filo di separazione e
 * l'ombra verso l'alto dichiarano che sotto c'è dell'altro — la stessa scelta
 * che `BulkSelectionBar` e `BulkAssignBar` fanno da sempre per le loro barre
 * galleggianti.
 *
 * `className` porta il RITAGLIO (i margini negativi che annullano il padding
 * della card ospite) e la SUPERFICIE, che sono le due sole cose che cambiano fra
 * le due schermate: il bianco della card di nido·infanzia, la crema del pannello
 * della primaria.
 */
interface Props {
  /**
   * In ordine: i messaggi che parlano dell'azione (il rifiuto del server, la
   * riga che dice perché il comando non risponde) e per ultimo il comando.
   */
  children: ReactNode;
  /** Ritaglio e superficie della card ospite. */
  className?: string;
}

export function PiedeAzioneAssenza({ children, className }: Props) {
  return (
    <div
      className={
        'sticky bottom-[var(--kv-bottomnav-h)] z-40 space-y-3 border-t border-kidville-line ' +
        `shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.28)] ${className ?? ''}`
      }
    >
      {children}
    </div>
  );
}
