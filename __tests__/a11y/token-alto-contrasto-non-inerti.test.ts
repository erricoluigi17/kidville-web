import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK — nel blocco Alto Contrasto non si dichiarano token che nessuno legge.
 *
 * ─── IL DIFETTO, IN UNA RIGA ────────────────────────────────────────────────
 * `[data-contrast="high"] { --color-kidville-x: … }` SEMBRA dire «in Alto
 * Contrasto questo colore cambia». Molto spesso non cambia niente, e la riga
 * è documentazione che mente.
 *
 * ─── PERCHÉ ─────────────────────────────────────────────────────────────────
 * I token stanno in `@theme inline` (`globals.css:3`). L'opzione `inline` fa
 * INLINARE L'HEX dentro la utility: `.bg-kidville-cream` emette
 * `background-color:#FEF1E4` letterale, non `var(--color-kidville-cream)`.
 * Quindi ridefinire la variabile sotto `[data-contrast="high"]` **non tocca
 * nessuna classe Tailwind**: vale solo dove qualcuno scrive `var()` a mano —
 * i tre CSS module e le regole dentro `globals.css`.
 * (Misurato il 2026-09-04 sul browser: `bg-kidville-cream` resta
 * `rgb(254,241,228)` in entrambe le modalità. Lo dice anche
 * `contrasto-cascata.test.tsx:171-179`.)
 *
 * ─── NON È TEORIA: È GIÀ COSTATO ────────────────────────────────────────────
 * `--color-kidville-warn-strong: #FFB300` è rimasto in quel blocco, inerte,
 * fino al 2026-08-02 — e il commento a `globals.css` racconta che il giorno in
 * cui un `var()` ha cominciato a leggerlo sarebbe diventato ambra chiara su
 * fascia chiara, **1,52:1: peggio del difetto che stava chiudendo**.
 * Il 2026-09-04 è toccato a `--color-kidville-muted: #E0E0E0`, rimosso: zero
 * `var(--color-kidville-muted)` in tutto `src/`. Il sospetto gemello su `sub`
 * era invece infondato — lo leggono nove dichiarazioni in tre file.
 *
 * ─── LIMITE DICHIARATO ──────────────────────────────────────────────────────
 * Questa sonda trova i lettori SINTATTICI, non quelli raggiungibili: un `var()`
 * dentro una regola il cui selettore non colpisce mai niente qui conta come
 * lettore. A chiudere quel residuo può essere solo una misura a runtime.
 */

const RADICE = path.resolve(__dirname, '../..');
const GLOBALS = path.join(RADICE, 'src/app/globals.css');

/** I token ridefiniti dentro `[data-contrast="high"] { … }`. */
function tokenRidefinitiInAltoContrasto(): string[] {
  const css = fs.readFileSync(GLOBALS, 'utf8');
  const m = /\[data-contrast="high"\]\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*(--color-kidville-[a-z0-9-]+)\s*:/gm)].map((x) => x[1]);
}

/** Tutti i `var(--color-kidville-…)` scritti a mano in src/ (CSS, CSS module, TS/TSX). */
function tokenLettiDaVar(): Set<string> {
  const trovati = new Set<string>();
  const giro = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) giro(p);
      else if (/\.(css|tsx?)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/var\((--color-kidville-[a-z0-9-]+)/g)) {
          trovati.add(m[1]);
        }
      }
    }
  };
  giro(path.join(RADICE, 'src'));
  return trovati;
}

/**
 * DEBITO DICHIARATO — misurato il 2026-09-04: 27 token ridefiniti, 2 inerti.
 * Restano perché toglierli è una scelta che riguarda l'Alto Contrasto degli
 * stati «successo» e «informazione», e va fatta guardando quelle fasce, non
 * cancellando una riga. Ma restano CONTATI: un terzo inerte è rosso.
 */
const INERTI_NOTI = ['--color-kidville-success-strong', '--color-kidville-info-strong'];

describe('lock — nel blocco Alto Contrasto non si dichiarano token che nessuno legge', () => {
  it('CONTROLLO POSITIVO: le due sonde trovano davvero qualcosa', () => {
    const ridefiniti = tokenRidefinitiInAltoContrasto();
    const letti = tokenLettiDaVar();
    // Se il selettore del blocco cambia nome, o `@theme` sparisce, queste righe
    // cadono per prime invece di rendere verde un lock che non guarda più niente.
    expect(ridefiniti.length, 'nessun token ridefinito in [data-contrast="high"]: la sonda guarda altrove').toBeGreaterThan(10);
    expect(letti.size, 'nessun var(--color-kidville-…) in src/: la sonda guarda altrove').toBeGreaterThan(5);
    expect(fs.readFileSync(GLOBALS, 'utf8')).toContain('@theme inline');
  });

  it('CONTROLLO POSITIVO: `sub` è vivo, ed è la prova che un token LETTO si distingue', () => {
    // Se questa cadesse, la sonda non saprebbe distinguere vivo da morto, e
    // l'elenco degli inerti sarebbe una lista qualunque.
    expect(tokenRidefinitiInAltoContrasto()).toContain('--color-kidville-sub');
    expect(tokenLettiDaVar()).toContain('--color-kidville-sub');
  });

  it('gli unici token inerti sono quelli DICHIARATI, e sono esattamente quelli', () => {
    const letti = tokenLettiDaVar();
    const inerti = tokenRidefinitiInAltoContrasto().filter((t) => !letti.has(t));
    expect(
      inerti.sort(),
      'Un token ridefinito in Alto Contrasto che nessun `var()` legge è una riga che MENTE: ' +
        'sembra dire che quel colore cambia, e non cambia niente, perché le utility Tailwind ' +
        'portano l\'hex inlinato da `@theme inline`. Se ne hai aggiunto uno: o scrivi il `var()` ' +
        'che lo legge, o togli la riga. Se ne hai BONIFICATO uno: togli il suo nome da ' +
        'INERTI_NOTI qui sopra, altrimenti il permesso resta aperto.',
    ).toEqual([...INERTI_NOTI].sort());
  });

  it('`muted` NON torna nel blocco: era il caso del 2026-09-04', () => {
    expect(
      tokenRidefinitiInAltoContrasto(),
      '`--color-kidville-muted` è tornato in [data-contrast="high"]. Se qualcuno ha aggiunto un ' +
        '`var(--color-kidville-muted)` che lo legge, allora va bene e questa riga va aggiornata. ' +
        'Altrimenti è di nuovo la dichiarazione inerte rimossa il 2026-09-04.',
    ).not.toContain('--color-kidville-muted');
  });
});
