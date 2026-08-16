import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

import itAdminModulistica from '../../messages/it/adminModulistica.json';
import itPrestampatiSegreteria from '../../messages/it/prestampatiSegreteria.json';

/**
 * «MODULISTICA» — la barra delle linguette, letta come la legge la Segreteria.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────────
 *
 * `modulistica-linguette-raggiungibili.test.ts` legge il SORGENTE della pagina: verifica che
 * ogni linguetta della barra sia anche un valore di `?tab=`. È una prova sulla forma del
 * file, e va benissimo per quello che sorveglia — ma non monta niente, quindi non può dire
 * se la barra a schermo è quella giusta, né quante linguette ci sono, né che parola c'è
 * scritta sopra.
 *
 * Questa prova monta la pagina davvero. E la prima cosa che ha misurato è il difetto per cui
 * è nata: la quinta linguetta si leggeva **`prestampatiSegreteria.titolo`** invece di
 * «Prestampati». Non perché la pagina sbagliasse: perché il mock globale di next-intl
 * (`test/setup.ts`) montava i cataloghi UNO PER UNO, a mano, e `prestampatiSegreteria` —
 * nato il 2026-08-14 — non era nell'elenco. Il ripiego del mock è il nome della chiave,
 * quindi qualunque asserzione sul testo sarebbe stata VERDE su una stringa che nessuna
 * segretaria leggerà mai. Lo stesso file di setup metteva in guardia da sé contro questo
 * esatto guasto, a proposito di `parentAssenze`, e ci è ricascato con il catalogo dopo.
 *
 * Dal 2026-08-16 il mock non elenca più: legge la cartella `messages/it/` e monta ciò che
 * trova. Un catalogo nuovo non può più nascere già invisibile ai test — e questa prova è la
 * misura che lo dimostra, perché asserisce sul TESTO ITALIANO VERO preso dai due cataloghi,
 * non su una stringa scritta a mano qui dentro.
 *
 * ⚠️ Le etichette si leggono dai file JSON, non si ricopiano: una prova che ripete a mano il
 * testo che la pagina dovrebbe mostrare resta verde anche quando il catalogo cambia sotto.
 */

/**
 * `query` è la stringa di `?…` con cui la pagina viene montata, e si cambia da un test
 * all'altro. La prima versione di questo file montava sempre `new URLSearchParams('')`: tre
 * `it` che non hanno mai passato un `?tab=` nemmeno una volta, cioè una schermata provata
 * solo dalla porta d'ingresso principale. È il buco che i vecchi collegamenti attraversavano.
 */
const h = vi.hoisted(() => ({ fetchMock: vi.fn(), query: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', nome: 'Kidville Giugliano' }],
    selezionate: [],
    effettive: ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'],
    sedeCorrente: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    reFetchKey: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
  SedeNotice: () => null,
}));

// I cinque pannelli sono provati altrove: qui interessa solo la barra che li sceglie — con
// un'eccezione, «Moduli inviabili», che è anche il PANNELLO DI RIPIEGO: quando `?tab=` porta
// una parola che non esiste più, è lui che deve comparire. Un mock che rende `null` non
// distingue «pannello di ripiego disegnato» da «pagina bianca», che è esattamente il guasto
// da sorvegliare: quindi qui lascia un segno che si può cercare.
vi.mock('@/components/features/admin/iscrizioni/ModuliInviabili', () => ({
  ModuliInviabili: () => <div data-testid="pannello-inviabili" />,
}));
vi.mock('@/components/features/admin/iscrizioni/ModuliRicevuti', () => ({ ModuliRicevuti: () => null }));
vi.mock('@/components/features/admin/iscrizioni/CandidatureInsegnanti', () => ({ CandidatureInsegnanti: () => null }));
vi.mock('@/components/features/admin/personale/PratichePersonale', () => ({ PratichePersonale: () => null }));
vi.mock('@/components/features/prestampati/PrestampatiSegreteria', () => ({ PrestampatiSegreteria: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  h.query = '';
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubGlobal('fetch', h.fetchMock);
});

import AdminModulisticaPage from '@/app/(dashboard)/admin/modulistica/page';

/** Le sei linguette, nell'ordine in cui la barra le mostra, con il testo dei cataloghi. */
const LINGUETTE = [
  itAdminModulistica.modTabInviabili,
  itAdminModulistica.modTabRicevuti,
  itAdminModulistica.modTabCandidature,
  itAdminModulistica.modTabPersonale,
  itPrestampatiSegreteria.titolo,
  itAdminModulistica.modTabModuliGenitori,
];

/** Le etichette della barra `Tabs`, così come le legge chi guarda lo schermo. */
function etichetteDellaBarra(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.kv-cockpit-tabs button')].map(
    (b) => b.textContent?.trim() ?? '',
  );
}

/** La linguetta accesa: `aria-pressed="true"` è ciò che distingue la pillola verde. */
function linguettaAttiva(container: HTMLElement): string | null {
  const acceso = container.querySelector('.kv-cockpit-tabs button[aria-pressed="true"]');
  return acceso?.textContent?.trim() ?? null;
}

describe('/admin/modulistica — la barra delle linguette', () => {
  it('mostra SEI linguette, e ognuna col suo testo italiano vero', () => {
    const { container } = render(<AdminModulisticaPage />);
    expect(etichetteDellaBarra(container)).toEqual(LINGUETTE);
  });

  it('nessuna etichetta è il NOME di una chiave i18n rimasta irrisolta', () => {
    // Il ripiego del mock di next-intl è `namespace.chiave`: se una linguetta si legge così,
    // il catalogo non è montato e ogni asserzione sul testo di questa schermata è finta.
    const { container } = render(<AdminModulisticaPage />);
    const irrisolte = etichetteDellaBarra(container).filter((testo) =>
      /^[a-z][A-Za-z0-9]*\.[A-Za-z0-9]+$/.test(testo),
    );
    expect(
      irrisolte,
      'Queste linguette mostrano il nome della chiave invece della traduzione: ' +
        irrisolte.join(', ') +
        '. Il catalogo non è montato nel mock di next-intl — vedi test/setup.ts.',
    ).toEqual([]);
  });

  it('la «Sala d’Attesa» non è più una linguetta di questa schermata', () => {
    // Il pannello delle pre-iscrizioni è stato smontato il 2026-08-16: le domande di
    // iscrizione si leggono da «Moduli ricevuti». Se un giorno riapparisse una settima
    // linguetta con quel nome, sarebbe un pannello che duplica un lavoro che c'è già.
    const { container } = render(<AdminModulisticaPage />);
    expect(etichetteDellaBarra(container).filter((e) => /attesa/i.test(e))).toEqual([]);
  });

  /**
   * I COLLEGAMENTI VECCHI — la metà del lavoro che una linguetta cancellata si lascia dietro.
   *
   * `?tab=odt` e `?tab=attesa` sono link REALI, già circolati (segnalibri della Segreteria,
   * cronologia del browser), verso due linguette che dal 2026-08-16 non esistono più. Il
   * ripiego che li riporta su «Moduli inviabili» vive in un ternario, e finora nessuna prova
   * lo eseguiva: `modulistica-linguette-raggiungibili.test.ts` cerca il ripiego nel TESTO del
   * sorgente con una regexp — resta verde su qualunque ripiego, anche rotto — e questo file
   * montava sempre la pagina senza `?tab=`.
   *
   * Chi domani riscrivesse quel ternario come uno `switch` senza `default`, o stringesse il
   * tipo di `initialTab` togliendogli il ripiego, avrebbe una PAGINA BIANCA su ogni vecchio
   * collegamento — e tutti i lock verdi. Qui la pagina si monta davvero, una volta per
   * ciascuna delle tre parole, e si guarda cosa disegna.
   */
  describe('un `?tab=` che non esiste più non lascia la pagina vuota', () => {
    for (const parola of ['odt', 'attesa', 'linguetta-mai-esistita']) {
      it(`?tab=${parola} → sei linguette, «Moduli inviabili» accesa e il suo pannello disegnato`, () => {
        h.query = `tab=${parola}`;
        const { container, getByTestId } = render(<AdminModulisticaPage />);

        expect(etichetteDellaBarra(container)).toEqual(LINGUETTE);
        expect(
          linguettaAttiva(container),
          `«?tab=${parola}» non ha acceso nessuna linguetta: è lo stato in cui nessun ` +
            'pannello si disegna, cioè la pagina bianca.',
        ).toBe(itAdminModulistica.modTabInviabili);
        // Il pannello, non solo la pillola: una barra giusta sopra un vuoto resta un vuoto.
        expect(getByTestId('pannello-inviabili')).toBeTruthy();
      });
    }
  });

  /**
   * ─── E LO DICE, INVECE DI TACERLO ───────────────────────────────────────────────
   *
   * Il gruppo qui sopra prova che la pagina non si rompe. È metà del lavoro, e la metà
   * facile: il ripiego era **corretto e muto**. Chi apriva un vecchio segnalibro della
   * Segreteria si ritrovava su «Moduli inviabili» senza una parola di spiegazione, e la
   * conclusione naturale — davanti a una schermata che ha appena perso due linguette — non
   * è «mi hanno spostato», è «il mio lavoro è sparito».
   *
   * Questo è il difetto che nessun lock poteva vedere e nessun test misurava: una pagina
   * che funziona e non si spiega passa qualunque verifica automatica. Da qui in poi non
   * più.
   */
  describe('un `?tab=` che non esiste più lo DICE, invece di tacerlo', () => {
    /** L'avviso, come lo trova chi guarda: `role="status"`, cioè ciò che legge anche un lettore di schermo. */
    const avviso = (container: HTMLElement) => container.querySelector('[role="status"]');

    for (const parola of ['odt', 'attesa', 'linguetta-mai-esistita']) {
      it(`?tab=${parola} → spiega dove sono finite le domande di iscrizione`, () => {
        h.query = `tab=${parola}`;
        const { container } = render(<AdminModulisticaPage />);

        const riquadro = avviso(container);
        expect(
          riquadro,
          `«?tab=${parola}» riporta su un'altra linguetta SENZA dirlo: è la schermata che ` +
            'funziona e non si spiega, cioè il difetto che questo gruppo di prove esiste per chiudere.',
        ).toBeTruthy();
        // Il testo è quello del catalogo ITALIANO vero, non una stringa scritta qui: un
        // avviso che dice la cosa sbagliata è peggio di nessun avviso.
        expect(riquadro?.textContent ?? '').toContain(itAdminModulistica.modTabSconosciutaAvviso);
        // E manda in un posto che ESISTE: la linguetta nominata è una delle sei della barra.
        expect(etichetteDellaBarra(container)).toContain(itAdminModulistica.modTabRicevuti);
      });
    }

    it('senza `?tab=` non compare nessun avviso (chi entra dalla porta principale non ha sbagliato niente)', () => {
      h.query = '';
      const { container } = render(<AdminModulisticaPage />);
      expect(avviso(container)).toBeNull();
    });

    for (const parola of ['ricevuti', 'candidature', 'personale', 'prestampati', 'moduli-genitori']) {
      it(`?tab=${parola} è una linguetta VERA: apre la sua e non avvisa di niente`, () => {
        h.query = `tab=${parola}`;
        const { container } = render(<AdminModulisticaPage />);
        expect(
          avviso(container),
          `«?tab=${parola}» è una linguetta viva: un avviso qui direbbe il falso a chi ha ` +
            'seguito un collegamento perfettamente valido — ed è così che si impara a non leggerli.',
        ).toBeNull();
      });
    }

    it("l'avviso si può chiudere, e resta chiuso", async () => {
      // Un avviso che non si toglie di mezzo è un avviso che si impara a scavalcare con
      // gli occhi. Chi ha capito il messaggio deve poterlo far sparire.
      const { fireEvent } = await import('@testing-library/react');
      h.query = 'tab=linguetta-mai-esistita';
      const { container } = render(<AdminModulisticaPage />);

      const chiudi = container.querySelector<HTMLButtonElement>(
        `[role="status"] button[aria-label="${itAdminModulistica.modTabSconosciutaChiudi}"]`,
      );
      expect(chiudi, "l'avviso non ha un modo per essere chiuso").toBeTruthy();
      fireEvent.click(chiudi as HTMLButtonElement);
      expect(container.querySelector('[role="status"]')).toBeNull();
      // …e la schermata sotto è rimasta quella giusta.
      expect(linguettaAttiva(container)).toBe(itAdminModulistica.modTabInviabili);
    });
  });

  /**
   * LA BARRA E LA SUA UNICA FONTE. Le sei linguette nascono da `TAB_ORDINE`, in cima alla
   * pagina, e `?tab=` si confronta con lo stesso elenco. Prima vivevano in quattro punti
   * diversi dello stesso file, e due volte su due un `?tab=` è finito sulla linguetta
   * sbagliata in silenzio perché il quarto punto non era stato aggiornato.
   *
   * Questa prova è la misura che l'elenco è UNO: ogni linguetta della barra è anche un
   * `?tab=` che si apre, e nessuna è raggiungibile solo con il mouse.
   */
  it('ogni linguetta della barra è raggiungibile anche da `?tab=`', () => {
    const valori = ['inviabili', 'ricevuti', 'candidature', 'personale', 'prestampati', 'moduli-genitori'];
    expect(valori).toHaveLength(LINGUETTE.length);

    for (const [i, valore] of valori.entries()) {
      h.query = `tab=${valore}`;
      const { container, unmount } = render(<AdminModulisticaPage />);
      expect(
        linguettaAttiva(container),
        `«?tab=${valore}» non accende «${LINGUETTE[i]}»: è la forma del difetto che ha già ` +
          "colpito due volte — la parola c'è nella barra e manca nel riconoscimento di `?tab=`.",
      ).toBe(LINGUETTE[i]);
      unmount();
    }
  });
});
