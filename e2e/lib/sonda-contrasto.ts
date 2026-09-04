/**
 * Sonda di contrasto — misura il colore VERO di ogni scritta su una pagina resa.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * In questo repo il contrasto è sorvegliato da otto lock in jsdom, che sono
 * ottimi ma guardano una LISTA CHIUSA di componenti (23 su ~260). E la regola
 * `color-contrast` di axe **non viene mai eseguita**: lo dichiara
 * `__tests__/a11y/smoke.axe.test.tsx:10` — «il color-contrast non è calcolabile
 * senza layout». Risultato: le pagine PUBBLICHE erano state misurate a mano una
 * volta (tester-09, 2026-08), e le schermate AUTENTICATE — genitore, docente,
 * segreteria — **non le ha mai misurate nessuno**. È lì che il 2026-09-04 sono
 * state trovate 1098 scritte a 2,27:1 e 81 utility grigie fuori dai token.
 *
 * ─── COSA MISURA CHE GLI ALTRI NON VEDONO ───────────────────────────────────
 * Il layout vero: ereditarietà, alfa composta, `z-index`, e soprattutto **le
 * due modalità**. In Alto Contrasto i token `kidville-*` NON si ribaltano nelle
 * classi Tailwind (`@theme inline` inlina l'hex): l'Alto Contrasto è dipinto
 * superficie per superficie a mano, ~141 regole in `globals.css`. Girare qui in
 * `data-contrast="high"` non verifica «che i token si ribaltino»: verifica
 * **quali superfici sono state coperte a mano e quali no**. È l'unico modo di
 * saperlo.
 */

// ── Aritmetica WCAG ─────────────────────────────────────────────────────────
// Ricopiata da `__tests__/a11y/contrasto-cascata.test.tsx:47-70`, che non la
// esporta (importarla eseguirebbe i suoi `describe`). La copia NON è tacita:
// `__tests__/a11y/sonda-contrasto.test.ts` verifica che le due implementazioni
// diano gli stessi numeri sulle coppie di riferimento. Se divergono, si vede.

const canale = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** Luminanza relativa di un `rgb(r, g, b)` già composto. */
export const luminanza = (r: number, g: number, b: number) =>
  0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b);

/** Rapporto di contrasto WCAG, arrotondato a due decimali come fa tutto il repo. */
export const contrasto = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [luminanza(...a), luminanza(...b)];
  const [alto, basso] = x > y ? [x, y] : [y, x];
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100;
};

/** La soglia che si applica a un testo, secondo WCAG 1.4.3. */
export const soglia = (px: number, peso: number) => (px >= 24 || (px >= 18.66 && peso >= 700) ? 3 : 4.5);

// ── Il record di un fallimento ──────────────────────────────────────────────
/**
 * ⚠️ NIENTE DATI PERSONALI QUI DENTRO, MAI.
 * `playwright-report/` viene caricato come artifact e **questo repository è
 * pubblico**. Il 2026-08-04 quell'artefatto conteneva una password in chiaro,
 * perché la snapshot di accessibilità riporta i valori dei campi. Qui passano
 * solo: rotta, modalità, tag, CLASSI (che sono utility Tailwind, non dati),
 * colori, dimensioni, rapporto. Mai `textContent`, `aria-label`, `value`,
 * `title`, `alt`, `id`, `data-*` — dentro un'app che gestisce anagrafiche di
 * minori quei campi contengono nomi di bambini.
 */
export interface Fallimento {
  firma: string;
  inchiostro: string;
  fondo: string;
  px: number;
  peso: number;
  soglia: number;
  rapporto: number;
}

export interface EsitoSonda {
  fallimenti: Fallimento[];
  /** Nodi che la sonda ha guardato: se è 0, la sonda è cieca, non la pagina pulita. */
  esaminati: number;
  /** Sfondi NON calcolabili, contati per categoria. Non si ignorano in silenzio. */
  saltati: { gradiente: number; composizione: number; fondoIgnoto: number };
  /** Il controllo positivo iniettato: dice cosa la sonda ha visto delle 4 sonde finte. */
  controlloPositivo?: { sano: number; rotti: number; gradiente: number };
}

/**
 * La funzione che gira DENTRO la pagina. Deve essere autonoma: `page.evaluate`
 * la serializza, e un riferimento a qualcosa di fuori diventa un `ReferenceError`
 * al momento della valutazione. Per questo l'aritmetica è ripetuta qui dentro
 * invece di essere importata: è la stessa formula, e il test in vitest verifica
 * che i due esemplari coincidano.
 *
 * `opzioni.autotest` inietta quattro sonde note prima di misurare — un colore
 * sano, due rotti e uno sotto un gradiente — e riporta cosa la sonda ne ha
 * fatto. È la risposta al mock che risponde uguale a tutto: nello stesso run,
 * casi diversi devono avere esiti diversi.
 */
export function sondaDom(opzioni: { autotest: boolean }): EsitoSonda {
  const canaleI = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c: number[]) => 0.2126 * canaleI(c[0]) + 0.7152 * canaleI(c[1]) + 0.0722 * canaleI(c[2]);
  const rapporto = (a: number[], b: number[]) => {
    const x = lum(a);
    const y = lum(b);
    const alto = x > y ? x : y;
    const basso = x > y ? y : x;
    return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100;
  };
  const leggi = (c: string): number[] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const sopra = (f: number[], b: number[]) => [
    f[0] * f[3] + b[0] * (1 - f[3]),
    f[1] * f[3] + b[1] * (1 - f[3]),
    f[2] * f[3] + b[2] * (1 - f[3]),
    1,
  ];
  const testo = (c: number[]) => 'rgb(' + c.slice(0, 3).map((v) => Math.round(v)).join(', ') + ')';

  const saltati = { gradiente: 0, composizione: 0, fondoIgnoto: 0 };

  // Lo sfondo OPACO sotto un elemento, risalendo gli antenati e impilando gli
  // strati semitrasparenti. Ritorna null quando non è calcolabile: un gradiente
  // o un `filter` rendono il risultato indecidibile, e la risposta onesta è
  // «non lo so», non un numero inventato. Un crawler che tirasse a indovinare
  // segnalerebbe come rotto il testo bianco sopra il gradiente di una foto —
  // che è invece il rimedio WCAG corretto.
  const fondoDi = (el: Element): number[] | null => {
    const strati: number[][] = [];
    let n: Element | null = el;
    while (n) {
      const st = getComputedStyle(n);
      if (st.backgroundImage && st.backgroundImage !== 'none') { saltati.gradiente++; return null; }
      if (st.filter !== 'none' || (st.mixBlendMode && st.mixBlendMode !== 'normal')) { saltati.composizione++; return null; }
      const c = leggi(st.backgroundColor);
      if (c && c[3] > 0) {
        strati.push(c);
        if (c[3] === 1) {
          let base = strati[strati.length - 1];
          for (let i = strati.length - 2; i >= 0; i--) base = sopra(strati[i], base);
          return base;
        }
      }
      n = n.parentElement;
    }
    saltati.fondoIgnoto++;
    return null;
  };

  let sonde: HTMLElement | null = null;
  if (opzioni.autotest) {
    sonde = document.createElement('div');
    sonde.setAttribute('data-sonda-autotest', '1');
    sonde.innerHTML =
      '<div style="background:#ffffff"><span class="kv-sonda-sana" style="color:#000000">a</span>' +
      '<span class="kv-sonda-rotta-1" style="color:#bbbbbb">b</span>' +
      '<span class="kv-sonda-rotta-2" style="color:rgba(0,0,0,0.18)">c</span></div>' +
      '<div style="background-image:linear-gradient(#fff,#eee)"><span class="kv-sonda-gradiente" style="color:#777777">d</span></div>';
    document.body.appendChild(sonde);
  }

  const fallimenti: Fallimento[] = [];
  const viste = new Set<string>();
  let esaminati = 0;
  const autotest = { sano: 0, rotti: 0, gradiente: 0 };

  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // Solo i nodi con testo PROPRIO: altrimenti ogni antenato conterebbe di nuovo
    // il testo dei figli, e il numero dipenderebbe dalla profondità del markup.
    let ha = false;
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && (n.textContent ?? '').trim()) ha = true;
    if (!ha) continue;

    const fg0 = leggi(st.color);
    if (!fg0) continue;
    const gradPrima = saltati.gradiente;
    const bg = fondoDi(el);
    const classe = String((el as HTMLElement).className ?? '');
    if (!bg) {
      if (opzioni.autotest && classe.indexOf('kv-sonda-gradiente') >= 0 && saltati.gradiente > gradPrima) autotest.gradiente++;
      continue;
    }
    esaminati++;

    const fg = sopra(fg0, bg);
    const cr = rapporto(fg, bg);
    const px = parseFloat(st.fontSize);
    const peso = parseInt(st.fontWeight, 10) || 400;
    const s = px >= 24 || (px >= 18.66 && peso >= 700) ? 3 : 4.5;

    if (opzioni.autotest && classe.indexOf('kv-sonda-') === 0) {
      if (cr < s) autotest.rotti++; else autotest.sano++;
    }
    if (cr >= s) continue;

    // Si conta la FIRMA, non il nodo. Cinque righe di tabella rotte allo stesso
    // modo valgono 1: così il numero dipende dal CSS e dal markup — ciò che il
    // test vuole sorvegliare — e non dal volume dei dati seminati, che cambia
    // con la data. Un crawler che conta i nodi è instabile, e con `retries: 0`
    // un test instabile diventa un rosso continuo che qualcuno finirà per
    // cancellare.
    const firma = [
      el.tagName.toLowerCase(),
      classe.split(/\s+/).filter(Boolean).sort().join('.'),
      testo(fg),
      testo(bg),
      s,
    ].join(' | ');
    if (viste.has(firma)) continue;
    viste.add(firma);
    fallimenti.push({ firma, inchiostro: testo(fg), fondo: testo(bg), px, peso, soglia: s, rapporto: cr });
  }

  if (sonde) sonde.remove();
  return {
    fallimenti: fallimenti.sort((a, b) => a.rapporto - b.rapporto),
    esaminati,
    saltati: { ...saltati, gradiente: saltati.gradiente - (opzioni.autotest ? autotest.gradiente : 0) },
    controlloPositivo: opzioni.autotest ? autotest : undefined,
  };
}
