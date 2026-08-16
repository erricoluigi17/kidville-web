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

const h = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
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

// I cinque pannelli sono provati altrove: qui interessa solo la barra che li sceglie.
vi.mock('@/components/features/admin/iscrizioni/ModuliInviabili', () => ({ ModuliInviabili: () => null }));
vi.mock('@/components/features/admin/iscrizioni/ModuliRicevuti', () => ({ ModuliRicevuti: () => null }));
vi.mock('@/components/features/admin/iscrizioni/CandidatureInsegnanti', () => ({ CandidatureInsegnanti: () => null }));
vi.mock('@/components/features/admin/personale/PratichePersonale', () => ({ PratichePersonale: () => null }));
vi.mock('@/components/features/prestampati/PrestampatiSegreteria', () => ({ PrestampatiSegreteria: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
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
});
