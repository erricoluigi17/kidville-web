'use client';

import { useEffect } from 'react';

/**
 * Il campo a fuoco non resta coperto — né dall'alto né dal basso.
 *
 * ─── PERCHÉ NON SI CHIAMA PIÙ `CampoSottoAppBar` (R19, 2026-08-08) ───────────
 * Ha trattato per un giorno solo il bordo ALTO, perché è lì che il difetto era
 * stato misurato. Il quinto collaudo ha trovato il gemello dal basso: sulla
 * WebView a 390×731 la textarea del motivo sta a y 617→729 con il piede
 * appiccicato sollevato a 568→659 e la barra di navigazione a 647→707, e
 * `document.elementFromPoint` sul suo centro restituisce un altro comando.
 *
 * `scroll-margin-bottom` NON lo cura, ed è misurato e non dedotto: riprodotta la
 * geometria in Chromium, dopo `focus()` sul campo `scrollY` resta **0**. Il
 * browser porta in vista solo chi è GEOMETRICAMENTE fuori dalla viewport, e un
 * campo coperto è dentro la viewport — c'è solo qualcosa sopra di lui. Vale per
 * `scroll-margin-top` (già scritto sotto) e vale, per la stessa ragione, per il
 * suo gemello in basso: sono due modi diversi in cui la stessa proprietà non
 * viene consultata.
 *
 * Un nome che dice metà del lavoro è un debito: questo repo ha già pagato per un
 * documento che descriveva una protezione diversa da quella che c'era.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ IL CSS NON BASTAVA ─────────────────────────────
 * `globals.css` dichiara `scroll-margin-top: var(--kv-appbar-h)` su tutti i
 * campi dentro `[data-kv-shell]`: significa «quando mi porti in vista, lasciami
 * sopra lo spazio della barra». È applicato davvero — misurato sulla WebView
 * viva, `getComputedStyle(ta).scrollMarginTop === "82px"` — ma lo scorrimento
 * che Chromium esegue quando la tastiera riduce la viewport VISUALE
 * (731 → 399 px CSS) **non onora `scroll-margin`**: porta `scrollY` all'offset
 * di documento del campo, cioè lo allinea a `top: 0`. Che è sotto un header
 * `sticky` alto 82 px.
 *
 * La misura del collaudo Android del 2026-08-08, campo «Motivo (facoltativo)»
 * di `/parent/attendance`, subito dopo aver digitato «aaa»:
 *   {"scrollY":499,"taTop":0,"taBottom":112,"appbarBottom":82,"copertoPx":82}
 * cioè **82 px su 112 (73%) coperti**, e il testo digitato non visibile: si
 * leggeva solo nella barra dei suggerimenti della tastiera. È il campo che porta
 * la nota di natura sanitaria del minore: il genitore non poteva rileggere né
 * correggere quello che stava scrivendo. Non serviva nemmeno che ci fosse poco
 * spazio — il campo (112 px) entrava comodamente nei 399 px residui: Chromium
 * scorreva lo stesso.
 *
 * ─── COME COMPENSA ──────────────────────────────────────────────────────────
 * Si aspetta che il browser abbia fatto il PROPRIO scorrimento (il `resize` di
 * `visualViewport` più un giro di coda), poi si misura dove il campo è
 * FINITO e lo si riporta sotto la barra. La soglia non è un numero copiato: è il
 * bordo inferiore vero dell'AppBar (`.kv-appbar`), che sulla shell nativa
 * cresce della safe-area e sul web no. Senza AppBar in pagina non c'è niente da
 * compensare e non si tocca nulla.
 *
 * Si è scelta questa strada e NON «togliere lo `sticky` all'AppBar mentre la
 * tastiera è aperta»: quella fa saltare l'intestazione — cioè il titolo e il
 * comando «Indietro» — proprio mentre l'utente sta scrivendo.
 *
 * Lock: `__tests__/components/campo-sotto-appbar.test.tsx`, che misura
 * `getBoundingClientRect().top` del campo attivo, non la regola CSS.
 *
 * ─── PERCHÉ STA IN `features/shell` E NON IN `features/parent` ───────────────
 *
 * Ci ha vissuto fino al 2026-08-08, perché è lì che il difetto era stato
 * misurato, e il commento che stava qui diceva: «quando anche i layout docente e
 * cockpit lo adotteranno, va spostato in features/shell e montato una volta
 * sola». Cioè la regola stava nel commento invece che nel codice — la stessa
 * forma che questo ciclo ha già pagato tre volte.
 *
 * Le shell con `[data-kv-shell]` sono TRE (genitore, docente, cockpit) e tutte
 * e tre hanno una barra sticky in cima che copre il campo a fuoco allo stesso
 * modo: genitore e docente la stessa (`.kv-appbar`, `features/shell/AppBar`),
 * il cockpit la sua (`.kv-appbar-admin`, `AdminTopBarMobile`). Il componente sta
 * dove sta il comportamento, ed è montato una volta per shell.
 */

/**
 * Quanto si aspetta prima di misurare. Non è una pausa estetica: la correzione
 * deve arrivare DOPO lo scorrimento del browser, altrimenti si corregge una
 * posizione che sta per essere sovrascritta. Due giri di `requestAnimationFrame`
 * non bastano su WebView lenta; 120 ms sono sotto la soglia in cui l'occhio
 * legge un salto come «la pagina si è mossa da sola».
 */
const RITARDO_MS = 120;

const CAMPI = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export function CampoNonCoperto() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Il campo che va tenuto in vista è quello A FUOCO ADESSO, non quello che
     * era a fuoco quando abbiamo programmato la misura.
     *
     * ─── PERCHÉ NON È PIÙ UNO STATO (rilievo Q30) ────────────────────────────
     * Qui c'era una variabile `pendente`, e `riporta()` la azzerava PRIMA di
     * controllare se serviva correggere. Nella sequenza reale del dito i tre
     * momenti sono separati:
     *   1. tocco → `focusin`, tastiera ancora chiusa, campo a 223 px;
     *   2. scadono i 120 ms → si misura, 223 ≥ 82, non c'è niente da fare —
     *      e uscendo il componente aveva già dimenticato il campo;
     *   3. la tastiera si apre, Chromium riallinea il campo a `top: 0` e
     *      `visualViewport` emette `resize`: l'unico istante in cui il difetto
     *      esiste, e `programma()` non trovava più niente da correggere.
     * Il componente funzionava solo se il fuoco arrivava a tastiera GIÀ aperta,
     * cioè mai. Misurato sull'emulatore: 82 px su 112 coperti, tre volte su tre.
     *
     * `document.activeElement` non ha stato da tenere allineato: è vero al
     * momento in cui lo si legge, che è esattamente ciò che serve.
     */
    const campoAFuoco = (): HTMLElement | null => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.isConnected || !CAMPI.has(el.tagName)) return null;
      // Solo i campi della shell: fuori di lì non c'è nessuna AppBar sticky da
      // compensare, e muovere lo scorrimento sarebbe un effetto a sorpresa.
      if (!el.closest('[data-kv-shell]')) return null;
      return el;
    };

    const riporta = () => {
      // Il fuoco può essere andato altrove (tastiera chiusa, tocco su un altro
      // comando): scorrere adesso sarebbe un salto che nessuno ha chiesto.
      const el = campoAFuoco();
      if (!el) return;
      // ENTRAMBE le barre sticky del progetto, e vince la più BASSA: è quella
      // che copre davvero. `.kv-appbar` è la barra di genitore e docente,
      // `.kv-appbar-admin` quella del cockpit — due classi perché il padding di
      // safe-area si applica in due modi diversi (vedi globals.css), non perché
      // siano due comportamenti diversi. Senza AppBar in pagina la soglia è 0 e
      // non si tocca niente.
      const soglia = Math.max(
        0,
        ...Array.from(document.querySelectorAll('.kv-appbar, .kv-appbar-admin')).map(
          (b) => b.getBoundingClientRect().bottom,
        ),
      );

      /**
       * E LA SOGLIA DAL BASSO — il piede dell'azione e la barra di navigazione.
       *
       * Vince la più ALTA delle due, cioè il bordo superiore dello strato che
       * comincia per primo: è quella la linea sotto la quale il campo non si
       * vede più. Si interroga il DOM invece di leggere `--kv-bottomnav-h`
       * perché il piede cambia altezza con ciò che contiene (i messaggi
       * dell'azione, la nota sul trattamento) e perché quella variabile è una
       * FORMULA che ha già mentito di 2px. Senza nessuno dei due strati in
       * pagina — le schermate che non hanno il piede, il web fuori dalla shell —
       * la soglia è 0 e non si tocca niente.
       */
      const bassi = Array.from(
        document.querySelectorAll('.kv-piede-azione, [data-kv-barra-bassa]'),
      ).map((b) => b.getBoundingClientRect().top);
      const sogliaBassa = bassi.length ? Math.min(...bassi) : 0;

      if (soglia <= 0 && sogliaBassa <= 0) return;

      const r = el.getBoundingClientRect();
      let d = 0;
      // Sborda sotto lo strato che copre: si alza di quanto serve, non di più.
      if (sogliaBassa > 0 && r.bottom > sogliaBassa) d = r.bottom - sogliaBassa;
      // …ma se alzandolo finisce dietro l'AppBar, comanda l'alto: un campo si
      // legge dall'inizio, e vederne la coda senza l'inizio non serve a niente.
      // È anche il caso del campo più alto dello spazio fra le due barre.
      if (soglia > 0 && r.top - d < soglia) d = r.top - soglia;
      if (d === 0) return;
      // `scrollBy` positivo alza il contenuto (il campo sale), negativo lo
      // abbassa: è la stessa riga di prima, con un addendo in più.
      window.scrollBy(0, d);
    };

    const programma = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(riporta, RITARDO_MS);
    };

    const alFuoco = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !CAMPI.has(el.tagName)) return;
      if (!el.closest('[data-kv-shell]')) return;
      programma();
    };

    // La tastiera che si apre (o si richiude, o ruota il telefono) accorcia la
    // viewport visuale: è il segnale che lo scorrimento del browser è avvenuto.
    const alRidimensionamento = () => programma();

    document.addEventListener('focusin', alFuoco);
    window.visualViewport?.addEventListener('resize', alRidimensionamento);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('focusin', alFuoco);
      window.visualViewport?.removeEventListener('resize', alRidimensionamento);
    };
  }, []);

  return null;
}
