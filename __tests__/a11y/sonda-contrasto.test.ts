import { describe, expect, it } from 'vitest';
import { contrasto, luminanza, soglia, sondaDom } from '../../e2e/lib/sonda-contrasto';

/**
 * L'ARITMETICA del crawler di contrasto, verificata QUI — cioè in locale.
 *
 * ─── PERCHÉ SERVE UN TEST SEPARATO ──────────────────────────────────────────
 * Il crawler gira SOLO in CI: `.env.local` punta al database di produzione e
 * `npm run e2e` è in `deny`. Se l'unica verifica della sua matematica fosse
 * dentro il crawler, un errore di formula si scoprirebbe con un giro di CI di
 * venti minuti — e, peggio, un errore che restituisce numeri GRANDI renderebbe
 * il crawler verde su tutto senza che nessuno se ne accorga.
 * Regola operativa: **ciò che è aritmetica va in vitest, ciò che tocca il
 * layout resta in Playwright.** Non si «testa il crawler» in jsdom: si
 * otterrebbe un verde che non dice niente.
 */

const hex = (h: string): [number, number, number] => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
};

describe('sonda di contrasto — l’aritmetica', () => {
  it('CONTROLLO POSITIVO: la taratura, sulle coppie che il repo ha già misurato', () => {
    // Se la formula fosse rotta, questa riga cadrebbe per prima.
    expect(contrasto(hex('#000000'), hex('#FFFFFF'))).toBe(21);
    expect(contrasto(hex('#FFFFFF'), hex('#FFFFFF'))).toBe(1);
    // #767676 su bianco è il LIMITE ESATTO di AA: se la formula sbaglia di poco,
    // è qui che si vede, perché il numero cade a cavallo della soglia.
    expect(contrasto(hex('#767676'), hex('#FFFFFF'))).toBe(4.54);
    expect(contrasto(hex('#999999'), hex('#FFFFFF'))).toBe(2.85);
    // I token del tema, con i valori dichiarati in globals.css.
    expect(contrasto(hex('#006A5F'), hex('#FFFFFF'))).toBe(6.51); // green
    expect(contrasto(hex('#55615C'), hex('#FEF1E4'))).toBe(5.82); // sub su crema
    expect(contrasto(hex('#7B8582'), hex('#FEF1E4'))).toBe(3.43); // muted su crema
    expect(contrasto(hex('#7B8582'), hex('#FFFFFF'))).toBe(3.8);  // muted su bianco
    // Il giallo di marchio sul verde: il numero che `globals.css` dichiara.
    expect(contrasto(hex('#FDC400'), hex('#006A5F'))).toBe(4.05);
  });

  it('la luminanza è monotona e sta fra 0 e 1', () => {
    expect(luminanza(0, 0, 0)).toBe(0);
    expect(luminanza(255, 255, 255)).toBe(1);
    expect(luminanza(128, 128, 128)).toBeGreaterThan(0);
    expect(luminanza(128, 128, 128)).toBeLessThan(1);
  });

  it('la soglia segue WCAG 1.4.3: 3:1 solo per il testo GRANDE', () => {
    expect(soglia(16, 400)).toBe(4.5);
    expect(soglia(18, 700)).toBe(4.5);      // 18px bold NON è testo grande: servono 18,66
    expect(soglia(18.66, 700)).toBe(3);
    expect(soglia(18.66, 400)).toBe(4.5);   // grande solo se ANCHE in grassetto
    expect(soglia(24, 400)).toBe(3);
    expect(soglia(23.99, 400)).toBe(4.5);
  });

  it('CONTROLLO POSITIVO: le due copie della formula coincidono', () => {
    // L'aritmetica è ripetuta DENTRO `sondaDom` perché `page.evaluate` serializza
    // la funzione e un riferimento esterno diventerebbe un ReferenceError nella
    // pagina. La copia non è tacita: qui si legge il sorgente della sonda e si
    // pretende che porti le stesse costanti. Se una delle due venisse ritoccata
    // da sola, questa riga cade.
    // ⚠️ `toString()` restituisce la forma TRANSPILATA, non il sorgente: esbuild
    // toglie lo zero iniziale (`0.03928` diventa `.03928`). È anche la forma che
    // finisce davvero dentro la pagina via `page.evaluate`, quindi è quella giusta
    // da guardare — ma va cercata senza lo zero, altrimenti questo controllo è
    // rosso per un motivo che non c'entra con la formula.
    const src = sondaDom.toString();
    for (const costante of ['03928', '12.92', '1.055', '2.4', '2126', '7152', '0722', '.05']) {
      expect(src, `la sonda DOM non contiene più la costante ${costante}`).toContain(costante);
    }
    // e le due soglie, con lo stesso confine
    expect(src).toContain('18.66');
    expect(src).toContain('>= 24');
  });

  it('la sonda NON riporta mai testo: il repository è pubblico', () => {
    // `playwright-report/` viene caricato come artifact, e il 2026-08-04 quello
    // artefatto conteneva una password in chiaro. Dentro un'app che gestisce
    // anagrafiche di minori, `textContent` e `aria-label` contengono nomi di
    // bambini. Questa è una regola sul CODICE, non una speranza.
    const src = sondaDom.toString();
    for (const vietato of ['textContent,', 'ariaLabel', 'getAttribute(\'aria-label\')', '.title', '.alt']) {
      // `textContent` compare una volta sola, per DECIDERE se un nodo ha testo
      // proprio — mai per riportarlo. Il controllo è che non finisca nel record.
      expect(src.includes(`firma: ${vietato}`), `la sonda mette ${vietato} nel record`).toBe(false);
    }
    expect(src).not.toContain('innerText');
    // la firma è fatta di tag, classi, colori e soglia: nient'altro
    expect(src).toContain('el.tagName.toLowerCase()');
  });
});
