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
/**
 * ─── LA RISERVA DI SOLLEVAMENTO — il terzo bloccante dello stesso pulsante ───
 *
 * `sticky` è una promessa condizionata: **non può sollevare una scatola oltre il
 * bordo alto del proprio blocco contenitore.** Sulla card della primaria quel
 * blocco è il pannello crema, che si apre a metà schermata e porta ~280px sopra
 * il piede; su un telefono da 640px il sollevamento richiesto è 364px e quello
 * disponibile ~270. Misurato il 2026-08-08 a 390×640, scroll 40:
 *
 *   posizione statica  853→932 · richiesta 489→568 · RESA 571→650
 *
 * cioè il piede bloccato a 24px dal bordo interno del pannello, dentro la fascia
 * della barra, e `page.mouse.click` al centro del pulsante che apre
 * /parent/avvisi. Matrice a 390px: coperto 54/54 fino a 667px d'altezza, 42/54 a
 * 690, 32/54 a 700, 12/54 a 720. La gemella `/parent/attendance` non cedeva —
 * non per merito, ma perché il suo `<form>` porta ~450px sopra il piede: la
 * stessa anatomia con più contenuto sopra. Un margine di manovra non è una
 * garanzia: è un numero che il prossimo contenuto può consumare.
 *
 * LA GARANZIA sta nella definizione dello sticky (CSS Position 3): il rettangolo
 * di vincolo è il padding box del blocco contenitore **rientrato dei margini
 * della scatola appiccicata — e un margine NEGATIVO lo allarga**. Un margine
 * negativo di due schermate sposta il limite due schermate più in su: da lì in
 * poi il vincolo non può più mordere, qualunque sia l'altezza dello schermo,
 * qualunque sia la posizione di scorrimento e qualunque sia il pannello che
 * ospita il piede. Non «riservo abbastanza spazio»: **tolgo il tetto**.
 *
 * Perché non le due strade ovvie:
 *   · spostare il piede nella `<section>` della card → il tetto si alza di ~90px
 *     e basta a 640, non a 568: resta un numero che dipende da dove la card cade
 *     nella pagina, cioè dai dati del genitore;
 *   · `padding-bottom` sul pannello → misurato: non cambia NIENTE. Il vincolo è
 *     sul bordo ALTO del contenitore, e il padding sta in fondo.
 *
 * Verificato su Blink e su WebKit (il motore della WebView iOS) con un documento
 * minimo: pannelli alti uguali al pixel, e il piede con la riserva reso a 1810
 * dove quello senza si ferma a 912. Lock: la sezione R21 di
 * `__tests__/pages/assenze-rifiniture-secondo-collaudo.test.tsx`, che riproduce
 * quelle misure e poi verifica l'invariante su ogni altezza da 320 a 1200px.
 */
const RISERVA_SOLLEVAMENTO = {
  /** Alto due schermate: il piede se lo riprende tutto, la somma è zero. */
  spaziatore: 'h-[200vh]',
  /** …e questo è il margine che allarga il vincolo. Stesso numero, obbligatorio. */
  margine: '-mt-[200vh]',
} as const;

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
    <>
      {/*
        LO SPAZIATORE CHE COMPENSA LA RISERVA — e il respiro sopra il piede.

        `RISERVA_SOLLEVAMENTO` è alto due schermate e il piede se lo riprende
        tutto con un margine negativo identico: la somma è zero, il flusso non si
        sposta di un pixel (misurato: i due pannelli, con e senza, restano alti
        uguali al pixel su Chrome e su WebKit). Serve solo perché il margine
        negativo del piede abbia qualcosa da annullare.

        `mt-4` sta QUI e non nel `className` di chi ospita: il margine superiore
        del piede è ormai load-bearing — è lui che allarga il vincolo — e non può
        essere sovrascritto da fuori. Le due schermate lo dichiaravano diverso
        (16px sulla pagina, 12px sulla card): un altro 4px della stessa famiglia.

        `aria-hidden`: è una scatola vuota alta due schermate, chi ascolta non
        deve incontrarla.
      */}
      <div aria-hidden className={`mt-4 ${RISERVA_SOLLEVAMENTO.spaziatore}`} />
      <div
        className={
          `sticky bottom-[var(--kv-bottomnav-h)] z-40 ${RISERVA_SOLLEVAMENTO.margine} ` +
          'space-y-3 border-t border-kidville-line ' +
          `shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.28)] ${className ?? ''}`
        }
      >
        {children}
      </div>
    </>
  );
}
