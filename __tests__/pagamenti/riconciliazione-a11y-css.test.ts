import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Lock a11y della Riconciliazione lato CSS (globals.css). Le regole di colore/focus
 * non sono testabili in DOM (jsdom non calcola il contrasto), ma la LORO PRESENZA sì:
 * qui si blocca la regressione dei findings A2 (testo «suggerito» invisibile in Alto
 * Contrasto) e A3 (anello di focus invisibile sui controlli a fondo pieno).
 */
const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8')

describe('globals.css — a11y Riconciliazione', () => {
  it('A2: in Alto Contrasto le righe schiariscono ESPLICITAMENTE il testo dei discendenti', () => {
    // Il box diventa nero: il testo `text-kidville-ink` (inlinato scuro da @theme inline)
    // va forzato a un colore chiaro, altrimenti sparisce sul fondo nero.
    //
    // ⚠️ LA REGOLA È DIVENTATA PIÙ LARGA, NON PIÙ DEBOLE (2026-09-05): prima
    // valeva per la sola `.kv-recon-row--suggerito`, e infatti la riga
    // «ignorato» — che scrive in `ink` e in `sub` — restava col suo grigio
    // chiaro. Adesso vale per `.kv-recon-row`, che quelle classi le porta tutte,
    // «suggerito» compreso: il caso che questo lock difendeva è dentro il nuovo.
    expect(css).toMatch(
      /\[data-contrast="high"\][^{]*\.kv-recon-row\s+\.text-kidville-ink:not\(\.kv-recon-chip\)[^{]*\{[^}]*color:\s*#(?:FFFFFF|FFF)\b/i,
    )
    // e la riga «suggerito» porta davvero l'àncora comune (JSX: `kv-recon-row` +
    // `kv-recon-row--suggerito` sullo stesso elemento), altrimenti la regola larga
    // non la coprirebbe e questo lock starebbe misurando un'altra cosa
    expect(css).toContain('[data-contrast="high"] .kv-recon-row--suggerito')
  })

  /**
   * ─── IL CHIP DI FATTURAZIONE IN ALTO CONTRASTO ──────────────────────────────
   *
   * `@theme inline` INLINA l'hex dentro le utility Tailwind: ridefinire
   * `--color-kidville-*` sotto `[data-contrast="high"]` NON cambia una sola
   * classe già generata. Una superficie nuova, in Alto Contrasto, o è dipinta a
   * mano o non esiste — e «non esiste» qui significa un chip bianco-su-verde
   * lasciato a sé stesso sopra una riga che il tema ha ridisegnato.
   *
   * Il chip prende il linguaggio HC del repo: carta bianca, inchiostro nero,
   * contorno nero 2px (il contorno è ciò che lo stacca dal fondo della riga, non
   * il colore). «Da fatturare» resta l'unico distinguibile a colpo d'occhio —
   * giallo brillante #FFE500, lo stesso di `.kv-recon-row--suggerito` — perché è
   * l'unico chip che chiede di agire: perderlo nella fila dei bianchi
   * annullerebbe la ragione per cui esiste.
   */
  it('il chip di fatturazione ha una regola HC dedicata: carta bianca, inchiostro nero, contorno nero', () => {
    const i = css.indexOf('[data-contrast="high"] .kv-recon-chip {');
    expect(i, 'manca la regola Alto Contrasto di `.kv-recon-chip`').toBeGreaterThan(-1);
    const blocco = css.slice(i, css.indexOf('}', i));
    expect(blocco).toMatch(/background:\s*#(?:FFFFFF|FFF)\b/i);
    expect(blocco).toMatch(/color:\s*#(?:000000|000)\b/i);
    // il contorno, non il colore, è ciò che stacca il chip dal fondo della riga
    expect(blocco).toMatch(/box-shadow:[^;]*2px\s+#(?:000000|000)\b/i);
  });

  it('«Da fatturare» resta giallo brillante in HC (è l’unico chip che chiede di agire)', () => {
    const i = css.indexOf('[data-contrast="high"] .kv-recon-chip--da-fatturare');
    expect(i, 'manca la variante HC di `.kv-recon-chip--da-fatturare`').toBeGreaterThan(-1);
    const blocco = css.slice(i, css.indexOf('}', i));
    expect(blocco).toMatch(/background:\s*#FFE500\b/i);
    // e viene DOPO la regola comune, altrimenti il bianco la coprirebbe
    expect(i).toBeGreaterThan(css.indexOf('[data-contrast="high"] .kv-recon-chip {'));
  });

  it('le regole del chip stanno FUORI da ogni @layer (dentro perderebbero contro le utility)', () => {
    // `@theme inline` genera le utility dentro `@layer utilities`: in CSS un
    // layer perde SEMPRE contro ciò che sta fuori dai layer, a prescindere dalla
    // specificità. È l'unico motivo per cui queste regole vincono senza `!important`.
    const nudo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const profonditaPrimaDi = (ago: string) => {
      const j = nudo.indexOf(ago);
      expect(j, `selettore non trovato: ${ago}`).toBeGreaterThan(-1);
      let p = 0;
      for (const c of nudo.slice(0, j)) { if (c === '{') p++; else if (c === '}') p--; }
      return p;
    };
    expect(profonditaPrimaDi('[data-contrast="high"] .kv-recon-chip {')).toBe(0);
    expect(profonditaPrimaDi('[data-contrast="high"] .kv-recon-chip--da-fatturare')).toBe(0);
    // CONTROLLO POSITIVO: la sonda sa riconoscere una regola annidata, altrimenti
    // starebbe dicendo «fuori da un layer» su qualunque cosa.
    let p = 0;
    for (const c of '@layer utilities { .x { color: red; } ') { if (c === '{') p++; else if (c === '}') p--; }
    expect(p).toBeGreaterThan(0);
  });

  it('A3: il :focus-visible globale ha colore verde ESPLICITO (non solo var) e uno stacco visibile', () => {
    // La regola globale sta su una riga che inizia con `:focus-visible {`
    // (quella HC è `[data-contrast="high"] *:focus-visible`, esclusa dal match).
    const m = css.match(/\n:focus-visible\s*\{([\s\S]*?)\}/)
    expect(m, 'regola :focus-visible globale presente').toBeTruthy()
    const block = m![1]
    expect(block).toMatch(/#006A5F/i)
    expect(block).toMatch(/box-shadow/)
  })
})

/**
 * ─── IL POPUP DEL MOVIMENTO IN ALTO CONTRASTO (2026-09-05) ───────────────────
 *
 * MISURATO sulle schermate del giro precedente: in Alto Contrasto il popup era
 * IDENTICO alla luce normale — card bianca, riquadro crema, pillola verde tenue,
 * chip grigio. Trentuno testi su trentuno con la stessa coppia colore/fondo.
 * Non era una svista di una regola: non ce n'era nessuna. `@theme inline` INLINA
 * l'hex dentro le utility, quindi rimappare `--color-kidville-*` sotto
 * `[data-contrast="high"]` non tocca `.bg-kidville-white` né `.text-kidville-ink`:
 * una superficie nuova o è dipinta a mano o in Alto Contrasto non esiste.
 */
const blocco = (selettore: string): string => {
  const i = css.indexOf(selettore);
  expect(i, `manca la regola \`${selettore}\``).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
};

describe('globals.css — il popup del movimento in Alto Contrasto', () => {
  it('la card diventa nera con contorno bianco (non resta carta bianca)', () => {
    const b = blocco('[data-contrast="high"] .kv-recon-dialog {');
    expect(b).toMatch(/background:\s*#(?:000000|000)\b/i);
    expect(b).toMatch(/box-shadow:[^;]*2px\s+#(?:FFFFFF|FFF)\b/i);
  });

  it('inchiostri e occhielli si ribaltano — ma MAI dentro il chip, che è carta bianca', () => {
    // ink/sub inlinati scuri sul nero sparirebbero; il verde su nero vale 3,23:1.
    expect(css).toMatch(/\[data-contrast="high"\] \.kv-recon-dialog \.text-kidville-ink:not\(\.kv-recon-chip\)/);
    expect(css).toMatch(/\[data-contrast="high"\] \.kv-recon-dialog \.text-kidville-green:not\(\.kv-recon-chip\)/);
    // Il `:not` non è pignoleria: senza, la regola del popup (0,3,0) batterebbe
    // quella del chip (0,2,0) e scriverebbe giallo sulla carta bianca del chip —
    // 1,44:1, cioè il chip illeggibile proprio in Alto Contrasto.
    //
    // ⚠️ BIANCO, NON PIÙ GIALLO — ed è una correzione, non un ripensamento.
    // MISURATO sulle schermate del giro precedente: con questa regola a #FFE500
    // il popup in Alto Contrasto aveva SEI elementi gialli — occhiello di testa,
    // «€ 300,00», «ORDINANTE:», «Documenti», il chip e «Invia fattura» — di cui
    // uno solo si poteva premere. Un accento che colora quasi tutto non accenta
    // più niente: in luce normale la gerarchia reggeva perché il giallo era
    // riservato al chip, e accendendo l'Alto Contrasto si perdeva.
    // Il bianco su nero vale 21:1, cioè più del giallo: qui non si sta barattando
    // contrasto per gerarchia, si stanno avendo tutti e due.
    const verde = blocco('[data-contrast="high"] .kv-recon-dialog .text-kidville-green:not(.kv-recon-chip)');
    expect(verde).toMatch(/color:\s*#(?:FFFFFF|FFF)\b/i);
    expect(verde, 'il giallo su un occhiello lo trasforma nel colore di default').not.toMatch(/#FFE500/i);
  });

  /**
   * ─── IL GIALLO È IL COLORE DI CIÒ CHE SI TOCCA, E DI NIENT'ALTRO ────────────
   *
   * La regola qui sopra sistema gli occhielli, ma da sola non impedisce che il
   * giallo torni a spargersi: basta una regola nuova qualunque dentro
   * `.kv-recon-dialog`. Questo lock non guarda UNA riga, guarda l'INVARIANTE —
   * dentro il popup in Alto Contrasto, ogni regola che tira fuori #FFE500 deve
   * essere una regola di qualcosa di premibile.
   *
   * Le due sole ammesse: il CTA pieno (`.bg-kidville-green`, cioè «Conferma
   * questo» / «Apri Incasso unico» / la pill «CF») e il pulsante della fattura
   * (`.kv-recon-azione-fattura`). Il chip «Da fatturare» ha la sua regola fuori
   * da `.kv-recon-dialog` ed è l'eccezione dichiarata: è l'unico stato che chiede
   * di agire, e resta giallo apposta.
   */
  it('in Alto Contrasto il giallo del popup è riservato a ciò che si può premere', () => {
    const nudo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Ogni regola (selettore + corpo) che nomina il popup in Alto Contrasto.
    const regole = [...nudo.matchAll(/([^{}]*\.kv-recon-dialog[^{}]*)\{([^}]*)\}/g)];
    expect(regole.length, 'nessuna regola `.kv-recon-dialog` trovata').toBeGreaterThan(3);
    const gialle = regole.filter(([, , corpo]) => /#FFE500/i.test(corpo)).map(([, sel]) => sel.trim());
    for (const sel of gialle) {
      expect(
        /\.bg-kidville-green\b|\.kv-recon-azione-fattura/.test(sel),
        `il giallo su «${sel}» non è un comando: in Alto Contrasto colora ciò che si tocca`,
      ).toBe(true);
    }
    // CONTROLLO POSITIVO: la sonda sa davvero pescare il giallo dove c'è,
    // altrimenti direbbe «nessuna violazione» anche su un file vuoto.
    expect(gialle.length, 'il CTA della fattura in HC deve restare giallo').toBeGreaterThan(0);
  });

  it('le superfici (crema, verde tenue, bianco) e i filetti si ridipingono', () => {
    expect(blocco('[data-contrast="high"] .kv-recon-dialog .bg-kidville-cream')).toMatch(/#1A1A1A/i);
    expect(blocco('[data-contrast="high"] .kv-recon-dialog .bg-kidville-green-soft')).toMatch(/#(?:000000|000)\b/i);
    // il contorno dei bottoni secondari: la regola globale in HC lo porta a NERO
    // (giusto su carta bianca), che su una card nera è invisibile → qui va a bianco
    const bordi = blocco('[data-contrast="high"] .kv-recon-dialog button[class*="border-kidville-line"]');
    expect(bordi).toMatch(/border-color:\s*#(?:FFFFFF|FFF)\b/i);
    // …e viene DOPO la regola globale che lo aveva messo nero, altrimenti perde
    expect(css.indexOf('[data-contrast="high"] .kv-recon-dialog button[class*="border-kidville-line"]'))
      .toBeGreaterThan(css.indexOf('[data-contrast="high"] button[class*="border-kidville-line"]:not(:focus)'));
  });
});

/**
 * ─── IL PULSANTE DELLA FATTURA: 3,80:1 SUL CTA DELLA SCHERMATA ───────────────
 *
 * MISURATO sul giro precedente: «Invia fattura» era `text-kidville-muted`
 * (#7B8582) su bianco → **3,80:1**, sotto AA, alto 26px invece di 44, e con
 * l'aria di un pulsante disattivato. È l'azione per cui questa schermata esiste.
 *
 * `FatturaButton` è condiviso con altre viste e non si tocca qui: la pelle si
 * mette dal CONTENITORE, che dichiara il tono con `data-tono` — pieno verde
 * quando c'è da emettere, contornato quando il documento è già uscito. I colori
 * passano da `var()` e non da hex: così in Alto Contrasto il CTA si ribalta da
 * solo (bianco↔nero) anche prima che intervenga la regola HC dedicata.
 */
describe('globals.css — la pelle del pulsante fattura nel popup', () => {
  it('qualunque cosa renda il pulsante, il bersaglio arriva a 44px', () => {
    const b = blocco('.kv-recon-azione-fattura > a,');
    expect(b).toMatch(/min-height:\s*44px/);
  });

  /**
   * La coppia è scritta per esteso, e il motivo è il lock S16
   * (`__tests__/a11y/contrasto-token.test.ts`): quella sonda pesca ogni regola che
   * mette `var(--color-kidville-white)` accanto a un `background`, perché in Alto
   * Contrasto quel token vale #000000 e su una superficie chiara diventa una banda
   * nera sopra il testo. Qui il bianco è l'inchiostro su un pieno verde, non la
   * copertura — ma la sonda non può leggerlo dal corpo della regola, e il modo di
   * dirlo in `globals.css` è la coppia esplicita.
   */
  it('«da fatturare» e «scartata» sono un CTA PIENO (bianco su verde, 6,51:1)', () => {
    const b = blocco('.kv-recon-azione-fattura[data-tono="da_fatturare"] > button,');
    expect(b).toMatch(/background:\s*#006A5F\b/i);
    expect(b).toMatch(/color:\s*#(?:FFFFFF|FFF)\b/i);
    // …e MAI col token bianco: sarebbe nero in Alto Contrasto (lock S16)
    expect(b).not.toContain('var(--color-kidville-white)');
    // il tono «scartata» condivide la regola: una fattura respinta va RIFATTA
    expect(css).toContain('.kv-recon-azione-fattura[data-tono="scartata"] > button');
  });

  it('«fatturata» è secondario contornato: il documento c’è già, non è l’azione', () => {
    const b = blocco('.kv-recon-azione-fattura[data-tono="fatturata"] > a,');
    expect(b).toMatch(/color:\s*var\(--color-kidville-green\)/);
    expect(b).toMatch(/box-shadow:[^;]*var\(--color-kidville-green\)/);
  });

  it('in Alto Contrasto il CTA prende il giallo di segnale su inchiostro nero', () => {
    const b = blocco('[data-contrast="high"] .kv-recon-azione-fattura[data-tono="da_fatturare"] > button,');
    expect(b).toMatch(/background:\s*#FFE500\b/i);
    expect(b).toMatch(/color:\s*#(?:000000|000)\b/i);
  });

  /**
   * ⚠️ NIENTE `color` SUL DOCUMENTO GIÀ EMESSO, IN ALTO CONTRASTO — e non è una
   * dimenticanza. Il colore lo scrive
   * `.kv-recon-dialog .text-kidville-green:not(.kv-recon-chip)` (0,4,0), che pesa
   * più di questa regola (0,3,0), e dal 2026-09-05 lo porta a BIANCO (21:1).
   * Scriverlo qui sarebbe una riga MAI applicata, col compito di far credere il
   * contrario a chi legge il file: la stessa specie di
   * `--color-kidville-warn-strong` rimasto inerte per mesi.
   *
   * Ed è giusto che sia bianco: a distinguere questo pulsante dal CTA resta la
   * FORMA — contorno vuoto contro pieno giallo — che è il segnale che regge anche
   * per chi il giallo dal bianco non lo separa. Quando erano gialli tutti e due,
   * l'unica differenza era il riempimento e il giallo aveva smesso di significare
   * «premi qui», perché lo portavano anche gli occhielli e la cifra.
   */
  it('il pulsante «fatturata» in HC non dichiara un inchiostro che non verrebbe mai applicato', () => {
    const b = blocco('[data-contrast="high"] .kv-recon-azione-fattura[data-tono="fatturata"] > a,');
    // 1,5px e non 2: il tester design (2026-09-05, sera) ha misurato «Ricevuta» a 1,5px e
    // «Fattura» a 2px, fratelli nella stessa riga a 12px di distanza. Un solo peso per
    // due comandi di pari rango; il contorno bianco su nero resta il segnale.
    expect(b).toMatch(/box-shadow:[^;]*1\.5px\s+#(?:FFFFFF|FFF)\b/i);
    expect(b, 'una dichiarazione che perde la cascata è peggio di nessuna dichiarazione').not.toMatch(/color:/i);
  });

  it('tutte queste regole stanno FUORI da ogni @layer', () => {
    const nudo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const profondita = (ago: string) => {
      const j = nudo.indexOf(ago);
      expect(j, `selettore non trovato: ${ago}`).toBeGreaterThan(-1);
      let p = 0;
      for (const c of nudo.slice(0, j)) { if (c === '{') p++; else if (c === '}') p--; }
      return p;
    };
    expect(profondita('[data-contrast="high"] .kv-recon-dialog {')).toBe(0);
    expect(profondita('.kv-recon-azione-fattura[data-tono="da_fatturare"] > button,')).toBe(0);
  });
});

/**
 * ─── IN ALTO CONTRASTO LE RIGHE ERANO «UGUALI A PRIMA» ───────────────────────
 *
 * MISURATO campionando lo stesso pixel nelle due modalità: la card confermata
 * restava rgb(0,106,95), «da abbinare» rgb(198,40,40), «ignorato» rgb(240,242,241).
 * Sei righe su otto identiche al contrasto normale — si ribaltavano i chip, non il
 * fondo che li ospita. Un chip bianco con filetto nero su verde #006A5F non è Alto
 * Contrasto: è il tema di sempre con un contorno in più.
 *
 * Il linguaggio è quello già in uso da `.kv-come-pagare` e `.kv-appbar`: fondo
 * NERO per tutte, e lo stato lo dice il CONTORNO — bianco (confermato), giallo
 * (suggerito), rosso (da abbinare), grigio (ignorato). Il colore non porta più
 * l'informazione da solo: la porta il contorno, che resta visibile anche a chi i
 * colori non li separa.
 */
describe('globals.css — le righe del registro in Alto Contrasto', () => {
  it('ogni riga diventa nera con un contorno: nessuna resta la superficie di prima', () => {
    const b = blocco('[data-contrast="high"] .kv-recon-row {');
    expect(b).toMatch(/background:\s*#(?:000000|000)\b/i);
    expect(b).toMatch(/box-shadow:[^;]*2px\s+#(?:FFFFFF|FFF)\b/i);
    expect(b).toMatch(/color:\s*#(?:FFFFFF|FFF)\b/i);
  });

  it('lo stato lo dice il CONTORNO, e ogni stato ne ha uno suo', () => {
    const base = css.indexOf('[data-contrast="high"] .kv-recon-row {');
    const contorni: Record<string, RegExp> = {
      'kv-recon-row--confermato': /#(?:FFFFFF|FFF)\b/i,
      'kv-recon-row--suggerito': /#FFE500/i,
      'kv-recon-row--da_abbinare': /#FF5252/i,
      'kv-recon-row--ignorato': /#9E9E9E/i,
    };
    for (const [classe, colore] of Object.entries(contorni)) {
      const i = css.indexOf(`[data-contrast="high"] .kv-recon-row--${classe.split('--')[1]}`);
      expect(i, `manca la variante HC di \`.${classe}\``).toBeGreaterThan(-1);
      const b = css.slice(i, css.indexOf('}', i));
      expect(b, `il contorno di ${classe}`).toMatch(colore);
      // …e viene DOPO la regola comune, o il bianco la coprirebbe
      expect(i, `${classe} deve stare dopo la regola comune`).toBeGreaterThan(base);
    }
  });

  it('gli inchiostri scuri della riga si schiariscono — MAI dentro il chip', () => {
    // `ignorato` scrive in `ink`/`sub` (inlinati scuri): sul nero sparirebbero.
    const b = blocco('[data-contrast="high"] .kv-recon-row .text-kidville-ink:not(.kv-recon-chip)');
    expect(b).toMatch(/color:\s*#(?:FFFFFF|FFF)\b/i);
    expect(css).toContain('[data-contrast="high"] .kv-recon-row .text-kidville-sub:not(.kv-recon-chip)');
    // Il `:not` non è pignoleria: il chip «Da fatturare» è `text-kidville-ink` su
    // giallo. Senza l'esclusione questa regola (0,3,0) batterebbe quella del chip
    // (0,2,0) e scriverebbe bianco su giallo — 1,4:1, illeggibile.
    expect(css).not.toMatch(/\[data-contrast="high"\] \.kv-recon-row \.text-kidville-ink\s*\{/);
  });
});

/**
 * ─── «SCARTATA» PERDEVA IL ROSSO PROPRIO IN ALTO CONTRASTO ───────────────────
 *
 * Campionato: l'inchiostro del chip passava da rgb(198,40,40) a rgb(0,0,0), e i
 * tre chip «Fatturata», «In attesa SDI» e «Scartata» diventavano identici — carta
 * bianca, inchiostro nero, filetto nero. L'unico stato che obbliga qualcuno a
 * rifare il lavoro non si distingueva più dai due che non chiedono niente.
 *
 * Il rimedio NON è scrivere #FF5252 sul testo: su carta bianca vale 3,19:1, cioè
 * sotto AA, e la sonda del collaudo lo segnerebbe (giustamente) come un difetto.
 * Si ribalta il chip — fondo rosso, inchiostro nero: 6,58:1 — con la stessa
 * grammatica di «Da fatturare», che è giallo pieno per la stessa ragione. Restano
 * due chip di carta (le fatture che non chiedono niente) e due colorati (quelle
 * che chiedono di agire).
 */
describe('globals.css — il chip «Scartata» in Alto Contrasto', () => {
  it('si ribalta a rosso pieno con inchiostro nero (6,58:1), non a testo rosso su bianco', () => {
    const i = css.indexOf('[data-contrast="high"] .kv-recon-chip--scartata');
    expect(i, 'manca la variante HC di `.kv-recon-chip--scartata`').toBeGreaterThan(-1);
    const b = css.slice(i, css.indexOf('}', i));
    expect(b).toMatch(/background:\s*#FF5252\b/i);
    expect(b, 'il rosso su carta bianca vale 3,19:1: sarebbe sotto AA').not.toMatch(/color:\s*#FF5252/i);
    // …e viene DOPO la regola comune del chip, altrimenti il bianco la copre
    expect(i).toBeGreaterThan(css.indexOf('[data-contrast="high"] .kv-recon-chip {'));
  });

  it('resta un solo chip di segnale per ciascuna richiesta d’azione (giallo, rosso)', () => {
    // «Fatturata» e «In attesa SDI» non chiedono niente: restano carta bianca.
    expect(css).not.toContain('[data-contrast="high"] .kv-recon-chip--fatturata');
    expect(css).not.toContain('[data-contrast="high"] .kv-recon-chip--attesa');
  });
});
