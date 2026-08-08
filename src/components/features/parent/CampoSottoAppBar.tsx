'use client';

import { useEffect } from 'react';

/**
 * Con la tastiera aperta, il campo a fuoco non finisce dietro l'AppBar.
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
 * ⚠️ Vive sotto `features/parent` perché è lì che il difetto è stato misurato e
 * lì che è montato (il layout genitore). Il comportamento però è della SHELL:
 * quando anche i layout docente e cockpit lo adotteranno, va spostato in
 * `features/shell` e montato una volta sola.
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

export function CampoSottoAppBar() {
  useEffect(() => {
    let pendente: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const riporta = () => {
      const el = pendente;
      pendente = null;
      // Il fuoco può essere già andato altrove (tastiera chiusa, tocco su un
      // altro comando): scorrere adesso sarebbe un salto che nessuno ha chiesto.
      if (!el || !el.isConnected || document.activeElement !== el) return;
      const barra = document.querySelector('.kv-appbar');
      const soglia = barra ? barra.getBoundingClientRect().bottom : 0;
      if (soglia <= 0) return;
      const top = el.getBoundingClientRect().top;
      if (top >= soglia) return;
      // Solo di quanto serve: `scrollBy` negativo alza la pagina, cioè abbassa
      // il campo dentro la viewport.
      window.scrollBy(0, top - soglia);
    };

    const programma = () => {
      if (!pendente) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(riporta, RITARDO_MS);
    };

    const alFuoco = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !CAMPI.has(el.tagName)) return;
      // Solo i campi della shell: fuori di lì non c'è nessuna AppBar sticky da
      // compensare, e muovere lo scorrimento sarebbe un effetto a sorpresa.
      if (!el.closest('[data-kv-shell]')) return;
      pendente = el;
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
