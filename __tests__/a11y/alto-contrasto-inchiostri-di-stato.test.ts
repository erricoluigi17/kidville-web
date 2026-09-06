import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { contrasto } from '../../e2e/lib/sonda-contrasto';

/**
 * LOCK — in Alto Contrasto gli INCHIOSTRI DI STATO si ribaltano davvero.
 *
 * ─── IL DIFETTO, MISURATO IN CI (run 34008632435, 2026-09-06) ───────────────
 * Il crawler `e2e/contrasto-schermate.spec.ts` gira le stesse due rotte due
 * volte, in luce normale e con `data-contrast="high"`, e confronta gli INSIEMI
 * di coppie sotto soglia. Su `/parent/pagamenti` e su `/teacher` i due insiemi
 * erano IDENTICI: «le due modalità danno lo stesso identico esito: il cookie
 * non sta facendo niente». Cioè gli elementi illeggibili restavano illeggibili
 * uguali con l'Alto Contrasto acceso — che è precisamente ciò per cui l'Alto
 * Contrasto esiste. Otto firme, tutte riconducibili a quattro inchiostri:
 *
 *   /parent/pagamenti (390×844)
 *     a    .text-kidville-muted                      #7B8582 su #FFFFFF  3,80:1
 *     p    .font-maven.text-kidville-muted.text-xs   #7B8582 su #FFFFFF  3,80:1
 *     span .text-[10px].text-kidville-error          #E53935 su #FFFFFF  4,23:1
 *   /teacher (1440×900)
 *     span .bg-kidville-info-soft.text-kidville-info       #2A6FDB su #E9F1FB  4,20:1
 *     span .bg-kidville-success-soft.text-kidville-success #43A047 su #E7F3E8  2,89:1
 *     span idem, altro padding                              (stessa coppia)
 *     span style={{color:'#E53935'}}  (INLINE, fuori da questo lock)   4,23:1
 *     span style={{color:'#1F8A5B'}}  (INLINE, fuori da questo lock)   4,33:1
 *
 * ─── PERCHÉ NON BASTAVA RIMAPPARE I TOKEN ───────────────────────────────────
 * I token stanno in `@theme inline`: l'opzione `inline` fa INLINARE L'HEX dentro
 * la utility, quindi `.text-kidville-muted` emette `color:#7B8582` letterale.
 * Ridefinire `--color-kidville-muted` sotto `[data-contrast="high"]` non tocca
 * una sola classe Tailwind — è la lezione già pagata due volte in questo repo
 * (`--color-kidville-warn-strong` inerte fino al 2026-08-02,
 * `--color-kidville-muted` rimosso il 2026-09-04). L'Alto Contrasto qui si
 * dipinge a mano, e ciò che non è dipinto semplicemente non cambia.
 *
 * ─── E PERCHÉ LA CARTA NON SI RIBALTA CON L'INCHIOSTRO ──────────────────────
 * Il guscio del genitore e quello del docente sono
 * `<div class="min-h-screen bg-kidville-cream">`: hex inlinato, in Alto
 * Contrasto resta CREMA. Le card sono `bg-white`/`bg-kidville-white`: restano
 * BIANCHE. `[data-contrast="high"] body { background:#000 }` sta dietro e non si
 * vede. Sul cruscotto, in Alto Contrasto, la carta è CHIARA quasi ovunque —
 * ed è per questo che il rimedio è SCURIRE l'inchiostro, non schiarirlo. È la
 * stessa scelta già fatta da `.kv-admin-sheet`, `.kv-admin-nav`,
 * `.kv-admin-rowcard` e `.kv-public`, che portano i loro testi tokenizzati a
 * #000000 proprio perché la loro superficie in HC resta chiara.
 *
 * ─── IL DEBITO CHE QUESTO LOCK NON COPRE, DETTO INVECE CHE NASCOSTO ─────────
 * Le regole nuove agganciano le quattro utility ESATTE. Restano fuori:
 *   · le varianti con alfa (`text-kidville-muted/60`, 17 occorrenze in `src/`):
 *     un `[class*="…"]` le prenderebbe, ma prenderebbe anche
 *     `hover:text-kidville-muted` (4 occorrenze) e ne farebbe un colore fisso,
 *     spegnendo l'affordance invece di aggiungerne una;
 *   · le varianti di stato (`hover:text-kidville-error`, 47 occorrenze): sono
 *     uno stato, non il riposo, e nessuna delle otto firme misurate ne è una;
 *   · i due `style={{ color: … }}` INLINE della home docente: un foglio di
 *     stile non batte un attributo `style` senza `!important`, e la causa
 *     radice sta in `teacher/page.tsx` (tinte scritte a mano, fuori da
 *     `TINTA_FUNZIONE`), non qui.
 */

const GLOBALS = path.join(process.cwd(), 'src', 'app', 'globals.css');
const CSS = fs.readFileSync(GLOBALS, 'utf8');
/** Una regola citata in un commento non è una regola. */
const NUDO = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

interface Regola {
  selettore: string;
  /** I selettori della lista, uno per uno, ripuliti. */
  parti: string[];
  corpo: string;
  /** Dove comincia il selettore: serve a risolvere le parità di specificità. */
  da: number;
  /** Quante at-rule la contengono: 0 = fuori da ogni `@layer`/`@media`. */
  profondita: number;
}

/** Estrae le regole di primo livello (il corpo di una regola non contiene `{`). */
function regole(css: string): Regola[] {
  const out: Regola[] = [];
  let buf = '';
  let inizio = 0;
  let profondita = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '{') {
      const sel = buf.trim();
      if (sel.startsWith('@')) {
        profondita++;
        buf = '';
        i++;
        continue;
      }
      const fine = css.indexOf('}', i);
      out.push({
        selettore: sel,
        parti: sel.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
        corpo: css.slice(i + 1, fine),
        da: inizio,
        profondita,
      });
      i = fine + 1;
      buf = '';
      continue;
    }
    if (c === '}') {
      profondita--;
      buf = '';
      i++;
      continue;
    }
    if (buf.trim() === '') inizio = i;
    buf += c;
    i++;
  }
  return out;
}

const REGOLE = regole(NUDO);

const rgb = (h: string): [number, number, number] => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
};

const canale = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminanza = (h: string) => {
  const [r, g, b] = rgb(h);
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b);
};

/** I token del tema, letti da `@theme inline` (non ricopiati). */
const TEMA: Record<string, string> = Object.fromEntries(
  [...(/@theme inline\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '').matchAll(
    /--color-kidville-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g,
  )].map((m) => [m[1], m[2].toUpperCase()]),
);

/**
 * LE FASCE CHIARE DEL TEMA — calcolate, non elencate a mano.
 *
 * Sono i token con luminanza ≥ 0,5 MENO i due riempimenti di marchio
 * (`yellow` #FDC400 e `yellow-ink` #FFDA5C), che non sono superfici di testo:
 * è la stessa lista di tredici su cui `globals.css` misura già
 * `--color-kidville-yellow-strong`. Più il GIALLO dell'Alto Contrasto #FFE500,
 * che in HC è un riempimento vero (`.kv-tab-giallo`, `.kv-appello-row`).
 */
const RIEMPIMENTI_DI_MARCHIO = ['yellow', 'yellow-ink'];
const GIALLO_HC = '#FFE500';
const FASCE_CHIARE: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(TEMA).filter(
      ([n, h]) => luminanza(h) >= 0.5 && !RIEMPIMENTI_DI_MARCHIO.includes(n),
    ),
  ),
  'giallo-alto-contrasto': GIALLO_HC,
};

/** Gli inchiostri che le otto firme di CI hanno in comune. */
const INCHIOSTRI = ['muted', 'error', 'success', 'info'] as const;

/** La regola generica di un inchiostro in Alto Contrasto. */
const regolaInchiostro = (tok: string) =>
  REGOLE.find((r) => r.parti.includes(`[data-contrast="high"] .text-kidville-${tok}`));

const colore = (corpo: string): string | undefined =>
  /(?:^|;)\s*color\s*:\s*(#[0-9A-Fa-f]{6})/i.exec(corpo)?.[1]?.toUpperCase();

// =============================================================================
describe('§0 · CONTROLLO POSITIVO — la sonda misura la realtà, non un desiderio', () => {
  it('l’aritmetica riproduce le sei coppie misurate in CI (run 34008632435)', () => {
    // Se una di queste cadesse, tutto il resto di questo file starebbe misurando
    // qualcos'altro: sono i numeri usciti dal browser vero, non da qui.
    expect(contrasto(rgb('#7B8582'), rgb('#FFFFFF'))).toBe(3.8);
    expect(contrasto(rgb('#E53935'), rgb('#FFFFFF'))).toBe(4.23);
    expect(contrasto(rgb('#2A6FDB'), rgb('#E9F1FB'))).toBe(4.2);
    expect(contrasto(rgb('#43A047'), rgb('#E7F3E8'))).toBe(2.89);
    // rilievo (a) — l'anello di fuoco giallo contro la carta chiara della pagina
    expect(contrasto(rgb(GIALLO_HC), rgb('#FFFFFF'))).toBe(1.28);
    // rilievo (b) — la ✕ bianca sopra l'hover #F0F2F1 del popup
    expect(contrasto(rgb('#FFFFFF'), rgb('#F0F2F1'))).toBe(1.12);
  });

  it('quei sei numeri escono dai TOKEN dichiarati, non da hex ricopiati qui', () => {
    expect(TEMA.muted).toBe('#7B8582');
    expect(TEMA.error).toBe('#E53935');
    expect(TEMA.info).toBe('#2A6FDB');
    expect(TEMA.success).toBe('#43A047');
    expect(TEMA['info-soft']).toBe('#E9F1FB');
    expect(TEMA['success-soft']).toBe('#E7F3E8');
    expect(TEMA['neutral-soft']).toBe('#F0F2F1');
  });

  it('CONTROLLO POSITIVO: le fasce chiare sono TREDICI più il giallo dell’Alto Contrasto', () => {
    // Se il filtro sulla luminanza smettesse di funzionare, la misura sotto
    // girerebbe su un insieme vuoto e direbbe «tutto a posto» su qualunque cosa.
    expect(Object.keys(FASCE_CHIARE)).toHaveLength(14);
    expect(FASCE_CHIARE.white).toBe('#FFFFFF');
    expect(FASCE_CHIARE['cream-dark']).toBe('#F6E4D2');
    expect(FASCE_CHIARE['giallo-alto-contrasto']).toBe(GIALLO_HC);
    // …e i due riempimenti di marchio ne restano FUORI, come nel resto del file.
    expect(FASCE_CHIARE.yellow).toBeUndefined();
    expect(FASCE_CHIARE['yellow-ink']).toBeUndefined();
  });

  it('CONTROLLO POSITIVO: la sonda sa distinguere «dentro un @layer» da «fuori»', () => {
    const finte = regole('@layer utilities { .x { color: red; } } .y { color: blue; }');
    expect(finte.map((r) => [r.selettore, r.profondita])).toEqual([
      ['.x', 1],
      ['.y', 0],
    ]);
  });
});

// =============================================================================
describe('§1 · i quattro inchiostri hanno una regola di Alto Contrasto, e vale AAA', () => {
  it.each(INCHIOSTRI)('«%s» ha la sua regola, fuori da ogni @layer', (tok) => {
    const r = regolaInchiostro(tok);
    expect(
      r,
      `manca \`[data-contrast="high"] .text-kidville-${tok}\`: in Alto Contrasto quell'inchiostro ` +
        'resta l\'hex inlinato da `@theme inline` e la modalità non fa niente',
    ).toBeTruthy();
    // Le utility Tailwind stanno in `@layer utilities`, e in CSS un layer perde
    // SEMPRE contro ciò che è fuori dai layer: è l'unico motivo per cui questa
    // regola vince senza `!important`.
    expect(r!.profondita, 'dentro un @layer questa regola perderebbe contro la utility').toBe(0);
    expect(colore(r!.corpo), 'la regola non dichiara un colore').toMatch(/^#[0-9A-F]{6}$/);
  });

  it.each(INCHIOSTRI)(
    '«%s» tiene AAA (7:1) su OGNI fascia chiara del tema, giallo HC compreso',
    (tok) => {
      const c = colore(regolaInchiostro(tok)!.corpo)!;
      const misure = Object.entries(FASCE_CHIARE).map(
        ([nome, fondo]) => [nome, contrasto(rgb(c), rgb(fondo))] as const,
      );
      const [peggiore, minimo] = misure.reduce((a, b) => (b[1] < a[1] ? b : a));
      expect(
        minimo,
        `\`${c}\` scende a ${minimo}:1 sulla fascia «${peggiore}». In Alto Contrasto un ` +
          'inchiostro di stato deve stare sopra 7:1 su ogni carta chiara del tema: la modalità ' +
          'non esiste per arrivare ad AA per un pelo, esiste per non doverci pensare.',
      ).toBeGreaterThanOrEqual(7);
    },
  );

  it.each(INCHIOSTRI)(
    '«%s» regge AA (4,5:1) anche sui due riempimenti di marchio, dove non dovrebbe finire',
    (tok) => {
      const c = colore(regolaInchiostro(tok)!.corpo)!;
      for (const nome of RIEMPIMENTI_DI_MARCHIO) {
        expect(contrasto(rgb(c), rgb(TEMA[nome])), `${c} su ${nome}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('le tre firme di `/parent/pagamenti` e le due di `/teacher` sono CHIUSE', () => {
    const m = colore(regolaInchiostro('muted')!.corpo)!;
    const e = colore(regolaInchiostro('error')!.corpo)!;
    const i = colore(regolaInchiostro('info')!.corpo)!;
    const s = colore(regolaInchiostro('success')!.corpo)!;
    // Le coppie ESATTE che il crawler ha misurato, ricalcolate col colore nuovo.
    expect(contrasto(rgb(m), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(4.5); // era 3,80
    expect(contrasto(rgb(e), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(4.5); // era 4,23
    expect(contrasto(rgb(i), rgb(TEMA['info-soft']))).toBeGreaterThanOrEqual(4.5); // era 4,20
    expect(contrasto(rgb(s), rgb(TEMA['success-soft']))).toBeGreaterThanOrEqual(4.5); // era 2,89

    // Le DUE firme inline della home docente. Non dipendono da un token: il
    // colore lo scrive `style={{ color: s.tint }}` nell'array `SHORTCUTS`, e un
    // foglio di stile lo batte solo con `!important`. Finché queste due
    // asserzioni non c'erano, il titolo di questo test diceva «e le due di
    // /teacher sono CHIUSE» senza guardarle: sovradichiarava, che è il difetto
    // che questo repository caccia da mesi.
    const inline = REGOLE.find((r) => r.selettore === '[data-contrast="high"] .kv-tinta-inline');
    expect(inline, 'manca la regola di Alto Contrasto per `.kv-tinta-inline` (le tinte scritte a mano in teacher/page.tsx)').toBeTruthy();
    const ci = colore(inline!.corpo)!;
    expect(contrasto(rgb(ci), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(4.5); // erano 4,23 (#E53935) e 4,33 (#1F8A5B)
    expect(inline!.corpo, '`style` inline si batte solo con !important: senza, la regola è decorazione').toContain('!important');
  });

  it('le due classi-àncora sono DAVVERO nel componente: una regola senza elemento è morta', () => {
    const home = fs.readFileSync(
      path.join(process.cwd(), 'src', 'app', '(dashboard)', 'teacher', 'page.tsx'),
      'utf8',
    );
    // Il verso che conta è questo: la regola CSS esiste (sopra), e qui si prova
    // che ha su cosa attaccarsi. Le due cose separate resterebbero entrambe
    // verdi mentre il colore non cambia.
    expect(home, '`.kv-tinta-inline` non è più sull’occhiello delle scorciatoie: la regola di Alto Contrasto non tocca più niente').toContain('kv-tinta-inline ');
    expect(home, '`.kv-tinta-inline-pastiglia` non è più sulla pastiglia dell’icona').toContain('kv-tinta-inline-pastiglia ');
    // …e che il colore inline che quella regola deve coprire c'è ancora: il
    // giorno in cui le tinte passassero da TINTA_FUNZIONE, questo test va tolto
    // insieme alla regola, non lasciato verde a sorvegliare il nulla.
    expect(home, 'le tinte non sono più inline: togliere la regola `.kv-tinta-inline` invece di lasciarla a sorvegliare il nulla').toContain('style={{ color: s.tint }}');
  });
});

// =============================================================================
describe('§2 · la regola generica NON scavalca le superfici già dipinte a mano', () => {
  /**
   * Il blocco Alto Contrasto di `globals.css` dipinge una trentina di superfici
   * per-classe, e alcune sono NERE (`.kv-recon-row`, `.kv-recon-dialog`,
   * `.kv-come-pagare`, `.kv-appbar`, `.kv-admin-topbar`, `.kv-appello-avviso`,
   * `.kv-mensa-alt .bg-kidville-error-soft`). Là dentro un inchiostro SCURO
   * sarebbe nero su nero — cioè il difetto opposto, e peggiore.
   * Due presidi, non uno: la SPECIFICITÀ (le regole per-superficie portano una
   * classe in più, (0,3,0) contro (0,2,0)) e, per le parità, l'ORDINE.
   */
  it.each(INCHIOSTRI)('«%s»: il selettore è nudo — nessun qualificatore in più', (tok) => {
    const r = regolaInchiostro(tok)!;
    for (const parte of r.parti) {
      expect(
        parte,
        'un `:not()` o una classe in più qui alzerebbero la specificità a (0,3,0) e la regola ' +
          'generica comincerebbe a battere le superfici dipinte a mano',
      ).toMatch(/^\[data-contrast="high"\] \.(text|bg)-kidville-[a-z-]+$/);
    }
  });

  it.each(INCHIOSTRI)(
    '«%s»: ogni regola per-superficie che lo ridipinge sta DOPO (le parità le decide l’ordine)',
    (tok) => {
      const mia = regolaInchiostro(tok)!;
      // Senza questa riga il test passerebbe A VUOTO quando la regola generica
      // non esiste: `perSuperficie` sarebbe l'unica cosa guardata, e il ciclo
      // non girerebbe mai.
      expect(mia, `manca la regola generica di \`${tok}\``).toBeTruthy();
      const perSuperficie = REGOLE.filter((r) =>
        r.parti.some(
          (p) =>
            p.startsWith('[data-contrast="high"]') &&
            p.includes('.kv-') &&
            p.includes(`text-kidville-${tok}`),
        ),
      );
      for (const r of perSuperficie) {
        expect(
          r.da,
          `«${r.parti[0]}» sta PRIMA della regola generica: a parità di specificità vince ` +
            'l\'ultima, e su quella superficie l\'inchiostro tornerebbe quello generico',
        ).toBeGreaterThan(mia.da);
      }
    },
  );

  it('CONTROLLO POSITIVO: di regole per-superficie ce ne sono davvero (la sonda pesca)', () => {
    const trovate = REGOLE.filter((r) =>
      r.parti.some(
        (p) => p.startsWith('[data-contrast="high"]') && p.includes('.kv-') && p.includes('text-kidville-'),
      ),
    );
    expect(trovate.length, 'nessuna regola per-superficie trovata: la sonda guarda altrove').toBeGreaterThan(5);
  });
});

// =============================================================================
describe('§3 · le pastiglie a fondo soft hanno un contorno che le stacca dalla carta', () => {
  /**
   * `bg-kidville-success-soft` contro il bianco della card vale 1,12:1: la
   * pastiglia, come FORMA, non esiste. In luce normale è una scelta di stile; in
   * Alto Contrasto è la stessa grammatica che `.kv-recon-chip` ha già scelto —
   * «il contorno è ciò che lo stacca dal fondo, non il colore».
   */
  const PASTIGLIE: [string, string][] = [
    ['success', 'success-soft'],
    ['info', 'info-soft'],
    ['error', 'error-soft'],
  ];

  it.each(PASTIGLIE)('«%s» su fondo soft ha il suo contorno in Alto Contrasto', (tok, fondo) => {
    const sel = `[data-contrast="high"] .bg-kidville-${fondo}.text-kidville-${tok}`;
    const r = REGOLE.find((x) => x.parti.includes(sel));
    expect(r, `manca \`${sel}\``).toBeTruthy();
    expect(r!.profondita).toBe(0);
    const contorno = /box-shadow\s*:[^;]*?(#[0-9A-Fa-f]{6})/i.exec(r!.corpo)?.[1];
    expect(contorno, 'il contorno non dichiara un colore').toBeTruthy();
    // WCAG 1.4.11: 3:1 contro il fondo della pastiglia E contro la carta attorno.
    expect(contrasto(rgb(contorno!), rgb(TEMA[fondo]))).toBeGreaterThanOrEqual(3);
    expect(contrasto(rgb(contorno!), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
describe('§4 · l’anello di fuoco in Alto Contrasto ha il buio anche DA FUORI', () => {
  /**
   * ─── RILIEVO (a) DEL COLLAUDO ─────────────────────────────────────────────
   * Su 9 dei 16 stop da tastiera della Riconciliazione l'indicatore di fuoco
   * misurava 1,28:1. Non era un colore sbagliato: #FFE500 contro il nero vale
   * 16,46:1 ed è il giallo giusto. Era il LATO ESTERNO. La regola dipingeva
   *   nero 0→2px  ·  giallo 2→5px  ·  e poi la pagina
   * e la pagina, in Alto Contrasto, resta CHIARA (carta bianca delle card,
   * crema del guscio): 1,28:1 e 1,15:1. Il separatore nero c'era, ma stava solo
   * dal lato di dentro — e un anello ha due lati.
   * Il rimedio è chiudere il panino: un secondo anello nero OLTRE l'outline.
   * L'`outline` si dipinge SOPRA la `box-shadow` dello stesso elemento (CSS 2.1,
   * appendice E: gli outline sono l'ultimo passo), quindi il giallo resta
   * visibile e ai suoi due lati c'è nero.
   */
  const universale = REGOLE.find((r) => r.parti.includes('[data-contrast="high"] *:focus-visible'));

  const anelli = (corpo: string) =>
    [...corpo.matchAll(/(\d+(?:\.\d+)?)px\s+(#[0-9A-Fa-f]{6})/g)].map((m) => ({
      raggio: parseFloat(m[1]),
      colore: m[2].toUpperCase(),
    }));

  it('CONTROLLO POSITIVO: senza il secondo anello il giallo confina con la carta (1,28:1)', () => {
    // È il difetto, ricalcolato: se questa riga cadesse, la misura sotto non
    // starebbe dimostrando niente.
    expect(contrasto(rgb(GIALLO_HC), rgb('#FFFFFF'))).toBeLessThan(3);
    expect(contrasto(rgb(GIALLO_HC), rgb(TEMA.cream))).toBeLessThan(3);
  });

  it('la regola universale esiste, è gialla e sta fuori da ogni @layer', () => {
    expect(universale, 'manca `[data-contrast="high"] *:focus-visible`').toBeTruthy();
    expect(universale!.profondita).toBe(0);
    expect(universale!.corpo).toMatch(new RegExp(GIALLO_HC, 'i'));
  });

  it('l’anello giallo ha un vicino SCURO anche dal lato esterno (≥ 3:1)', () => {
    const corpo = universale!.corpo;
    const offset = parseFloat(/outline-offset\s*:\s*(\d+(?:\.\d+)?)px/.exec(corpo)?.[1] ?? '0');
    const spessore = parseFloat(/outline\s*:\s*(\d+(?:\.\d+)?)px/.exec(corpo)?.[1] ?? '0');
    const bordoEsterno = offset + spessore;
    expect(bordoEsterno, "l'outline non dichiara né spessore né distacco").toBeGreaterThan(0);

    const ombra = /box-shadow\s*:([^;]*)/.exec(corpo)?.[1] ?? '';
    const fuori = anelli(ombra).filter((a) => a.raggio > bordoEsterno);
    expect(
      fuori.length,
      `l'anello giallo finisce a ${bordoEsterno}px e nessuna box-shadow arriva più in là: ` +
        'dal lato esterno confina con la pagina, che in Alto Contrasto resta chiara (1,28:1)',
    ).toBeGreaterThan(0);
    for (const a of fuori) {
      expect(
        contrasto(rgb(a.colore), rgb(GIALLO_HC)),
        `l'anello esterno ${a.colore} non stacca dal giallo`,
      ).toBeGreaterThanOrEqual(3);
      // …e deve staccare anche dalla carta chiara su cui è posato, altrimenti
      // sposterebbe il problema di due pixel più in là.
      expect(contrasto(rgb(a.colore), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(3);
    }
  });

  it('il RICOVERO del fuoco (`.kv-fuoco-esito`) porta lo stesso identico anello', () => {
    // `fuoco.ts` esiste per non avere due linguaggi del fuoco nella stessa
    // pagina: se la regola universale cambia e questa no, tornano due.
    const ricovero = REGOLE.find((r) =>
      r.parti.includes('[data-contrast="high"] .kv-fuoco-esito:focus'),
    );
    expect(ricovero, 'manca `[data-contrast="high"] .kv-fuoco-esito:focus`').toBeTruthy();
    const norm = (c: string) =>
      Object.fromEntries(
        c
          .split(';')
          .map((r) => r.split(':'))
          .filter((p) => p.length > 1)
          .map(([k, v]) => [k.trim().toLowerCase(), v.replace(/\s+/g, ' ').trim().toUpperCase()]),
      );
    const a = norm(universale!.corpo);
    const b = norm(ricovero!.corpo);
    for (const prop of ['outline', 'outline-offset', 'box-shadow']) {
      expect(b[prop], `«${prop}» diverso dal fuoco di bottoni e link`).toBe(a[prop]);
    }
  });

  it('il riquadro del file (`focus-within:ring-*`) porta anch’esso l’anello esterno', () => {
    // È l'unico controllo dell'app il cui anello lo compone Tailwind e non
    // l'`outline`: se resta indietro torna a essere «l'unico che risponde
    // diverso», che è il difetto già chiuso due volte su questo stesso elemento.
    const r = REGOLE.find((x) =>
      x.parti.includes('[data-contrast="high"] label[class*="focus-within:ring-"]:focus-within'),
    );
    expect(r, 'manca la regola dell’anello del riquadro file').toBeTruthy();
    const ombra = /--tw-ring-shadow\s*:([^;]*)/.exec(r!.corpo)?.[1] ?? '';
    expect(ombra, 'la regola non ricompone `--tw-ring-shadow`').toContain('var(--tw-ring-color)');
    const nero = /(#000000|#000\b)/i.test(ombra);
    expect(
      nero,
      'nessun anello nero oltre il giallo: dal lato esterno la banda gialla confina con la carta',
    ).toBe(true);
  });
});

// =============================================================================
describe('§5 · nessuna superficie in Alto Contrasto si MANGIA l’anello di fuoco', () => {
  /**
   * ─── LA CAUSA RADICE DEL RILIEVO (a), TROVATA MISURANDO E NON INDOVINANDO ──
   *
   * Il collaudo ha contato **9 stop su 16** a 1,28:1 sulla Riconciliazione: le
   * cinque pill di stato, le tre del gruppo «Fatturazione» e ogni riga del
   * registro. Gli altri sette stop della STESSA schermata stavano bene. Se la
   * causa fosse stata soltanto «il giallo confina con la carta», sarebbero stati
   * sedici su sedici: la geometria dell'anello è la stessa per tutti.
   *
   * La differenza fra i nove e i sette è che i nove portano una regola di Alto
   * Contrasto che dichiara `box-shadow` sulla LORO superficie — e `box-shadow`
   * è UNA proprietà, non una pila: l'ultima dichiarazione che vince la cascata
   * la sostituisce INTERA.
   *   · `[data-contrast="high"] *:focus-visible` è (0,2,0) e sta a ~riga 484;
   *   · `[data-contrast="high"] .kv-recon-row--suggerito` è (0,2,0) e sta 200
   *     righe più in basso → a parità di specificità vince l'ultima, e il
   *     separatore nero del fuoco SPARISCE;
   *   · `[data-contrast="high"] .kv-cockpit-tabs button[aria-pressed="true"]` è
   *     (0,3,1) → vince a prescindere dall'ordine.
   * Resta il solo `outline` giallo, posato sulla carta chiara: 1,28:1. Il
   * comando è a fuoco e non si vede — in una schermata dove il fuoco è l'unico
   * modo di sapere dove si è.
   *
   * Il rimedio è per-superficie, come tutto l'Alto Contrasto di questo file:
   * ogni superficie che dichiara un `box-shadow` su qualcosa di FOCALIZZABILE
   * deve avere la sua variante `:focus-visible` che rimette il proprio contorno
   * E i due anelli del fuoco nella stessa dichiarazione.
   *
   * Questo lock non guarda una riga: guarda l'INVARIANTE, così la decima volta
   * non serve un altro collaudo per scoprirla.
   */

  /** I due anelli che il fuoco in Alto Contrasto deve sempre portare. */
  const NERO_DENTRO = /0 0 0 2px #000000/i;
  const NERO_FUORI = /0 0 0 7px #000000/i;

  /**
   * Le superfici FOCALIZZABILI che dichiarano un `box-shadow` in Alto Contrasto.
   * `.kv-recon-row` e le sue quattro varianti stanno qui e non nel setaccio
   * automatico perché la loro focalizzabilità non si legge dal selettore: la
   * classe sta su un `<button>` (`RiconciliazionePanel.tsx`), e il test lo
   * verifica invece di dichiararlo.
   */
  const SOLO_DAL_JSX = [
    '[data-contrast="high"] .kv-recon-row',
    '[data-contrast="high"] .kv-recon-row--confermato',
    '[data-contrast="high"] .kv-recon-row--suggerito',
    '[data-contrast="high"] .kv-recon-row--da_abbinare',
    '[data-contrast="high"] .kv-recon-row--ignorato',
  ];

  /** Un selettore nomina, in modo SINTATTICO, qualcosa che prende il fuoco? */
  const focalizzabile = (sel: string) =>
    sel
      .split(/\s+|>/)
      .filter(Boolean)
      .some(
        (c) =>
          /^(button|a|input|select|textarea|summary)([.:[]|$)/.test(c) ||
          c.includes('[role="tab"]') ||
          c.includes('[tabindex'),
      );

  /** Tutte le regole HC che dichiarano un `box-shadow`, spacchettate per selettore. */
  const conOmbra = REGOLE.flatMap((r) =>
    /(?:^|;|\s)box-shadow\s*:/.test(r.corpo)
      ? r.parti
          .filter((p) => p.startsWith('[data-contrast="high"]'))
          .map((p) => ({ sel: p, corpo: r.corpo }))
      : [],
  );

  /** Quelle che si mangiano l'anello: focalizzabili, e non già regole di fuoco. */
  const mangiaAnello = conOmbra.filter(
    (r) => !/:focus/.test(r.sel) && (focalizzabile(r.sel) || SOLO_DAL_JSX.includes(r.sel)),
  );

  it('CONTROLLO POSITIVO: il setaccio pesca davvero, e sa distinguere un contenitore', () => {
    expect(conOmbra.length, 'nessuna regola HC con box-shadow: il setaccio guarda altrove').toBeGreaterThan(10);
    expect(mangiaAnello.length, 'nessuna superficie focalizzabile trovata').toBeGreaterThan(5);
    // Un contenitore NON deve finire nell'elenco, o il lock chiederebbe varianti
    // di fuoco a una card che il fuoco non lo prende mai.
    expect(focalizzabile('[data-contrast="high"] .kv-admin-sheet')).toBe(false);
    expect(focalizzabile('[data-contrast="high"] .kv-recon-dialog .bg-kidville-green-soft')).toBe(false);
    // …e uno focalizzabile sì.
    expect(focalizzabile('[data-contrast="high"] .kv-cockpit-tabs button[aria-pressed="true"]')).toBe(true);
    expect(focalizzabile('[data-contrast="high"] .kv-come-pagare [role="tab"]')).toBe(true);
  });

  it('`.kv-recon-row` sta davvero su un `<button>` (l’elenco dichiarato non è un’opinione)', () => {
    const panel = fs.readFileSync(
      path.join(process.cwd(), 'src/components/features/admin/pagamenti/RiconciliazionePanel.tsx'),
      'utf8',
    );
    const i = panel.indexOf("'kv-recon-row relative");
    expect(i, 'la classe `kv-recon-row` non è più applicata così').toBeGreaterThan(-1);
    // Il tag che apre l'elemento: si risale fino alla `<` più vicina.
    expect(panel.slice(0, i).lastIndexOf('<button')).toBeGreaterThan(panel.slice(0, i).lastIndexOf('<div'));
  });

  it('ogni superficie con `box-shadow` che prende il fuoco ha la sua variante `:focus-visible`', () => {
    const senzaVariante = mangiaAnello
      .filter((r) => {
        const compagna = conOmbra.find(
          (c) => c.sel === `${r.sel}:focus-visible` && NERO_DENTRO.test(c.corpo) && NERO_FUORI.test(c.corpo),
        );
        return !compagna;
      })
      .map((r) => r.sel);
    expect(
      senzaVariante,
      'Queste superfici dichiarano un `box-shadow` in Alto Contrasto su un elemento che prende ' +
        'il fuoco: `box-shadow` è UNA proprietà, quindi la loro dichiarazione CANCELLA i due ' +
        'anelli del fuoco e resta il solo outline giallo sulla carta chiara — 1,28:1. Serve la ' +
        'variante `<selettore>:focus-visible` che rimetta il proprio contorno E i due anelli.',
    ).toEqual([]);
  });

  it('e la variante non perde il contorno della superficie (lo stato resta leggibile)', () => {
    for (const r of mangiaAnello) {
      const compagna = conOmbra.find((c) => c.sel === `${r.sel}:focus-visible`);
      expect(compagna, `manca \`${r.sel}:focus-visible\``).toBeTruthy();
      const inset = /box-shadow\s*:[^;]*?(inset [^,;]+)/i.exec(r.corpo)?.[1]?.trim();
      if (!inset) continue;
      expect(
        compagna!.corpo.replace(/\s+/g, ' '),
        `\`${r.sel}:focus-visible\` perde il contorno «${inset}»: a fuoco la riga smetterebbe di ` +
          'dire in che stato è',
      ).toContain(inset);
    }
  });
});
