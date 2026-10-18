import { describe, it, expect } from 'vitest';
import config from '../../next.config';

/**
 * Lock architettura · una linguetta diventata pagina lascia un RIMANDO, non un buco.
 *
 * Le candidature «Lavora con noi» sono uscite da Modulistica il 2026-10-17 e sono diventate
 * `/admin/candidature`. Il loro vecchio indirizzo, `/admin/modulistica?tab=candidature`, non è
 * un segnalibro raro: è scritto nel `link` di OGNI notifica `candidatura_ricevuta` già spedita
 * (~1.000 nel database a ottobre), che campanella, push e service worker aprono così come sono.
 *
 * Il rimando principale sta nel server — `redirects()` in `next.config.ts` — perché parte prima
 * ancora che la pagina si carichi, anche da una push aperta a telefono spento. Il secondo, per
 * la navigazione interna all'app, sta in `LINGUETTE_TRASFERITE` della pagina di Modulistica ed è
 * provato da `__tests__/pages/admin-modulistica-linguette.test.tsx`.
 *
 * Qui si leggono le regole che `redirects()` restituisce DAVVERO (non si cerca una stringa nel
 * sorgente, che un commento basterebbe a far trovare).
 */
describe('lock architettura · i vecchi link delle candidature portano alla pagina nuova', () => {
  it('`/admin/modulistica?tab=candidature` rimanda a `/admin/candidature`', async () => {
    expect(typeof config.redirects, 'next.config non dichiara `redirects()`').toBe('function');
    const regole = await config.redirects!();

    const regola = regole.find(
      (r) =>
        r.source === '/admin/modulistica' &&
        (r.has ?? []).some((h) => h.type === 'query' && h.key === 'tab' && h.value === 'candidature'),
    );
    expect(
      regola,
      'Nessun rimando per `/admin/modulistica?tab=candidature`: ogni notifica di candidatura già ' +
        'spedita aprirebbe «Moduli inviabili» con un avviso che parla di domande di iscrizione.',
    ).toBeDefined();
    expect(regola?.destination).toBe('/admin/candidature');
    // Temporaneo: un 308 resterebbe nella cache del browser per sempre, e il giorno in cui
    // l'indirizzo cambiasse ancora non ci sarebbe modo di riprenderselo.
    expect(regola && 'permanent' in regola ? regola.permanent : undefined).toBe(false);
  });

  it('il rimando non tocca le linguette che ci sono ancora', async () => {
    const regole = (await config.redirects?.()) ?? [];
    const daModulistica = regole.filter((r) => r.source === '/admin/modulistica');
    for (const r of daModulistica) {
      // Una regola senza condizione sulla query porterebbe via TUTTA Modulistica.
      expect((r.has ?? []).some((h) => h.type === 'query' && h.key === 'tab')).toBe(true);
    }
  });
});
