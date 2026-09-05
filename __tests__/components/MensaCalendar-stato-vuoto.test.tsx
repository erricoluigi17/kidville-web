import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lo STATO VUOTO del calendario mensa, e l'inchiostro con cui è scritto.
 *
 * «Nessun giorno mensa in questa settimana.» è una frase che legge un GENITORE, ed è
 * l'unica cosa presente a schermo quando la settimana non ha giorni configurati: se non
 * si legge, la pagina sembra rotta invece che vuota. Era scritta con
 * `text-kidville-muted` (#7B8582 = 3,43:1 sul crema della shell genitore), sotto i 4,5:1
 * che WCAG 1.4.3 chiede per il testo — lo stesso difetto corretto in `fc5d0033` sulla
 * schermata dei pagamenti, che quel commit segnalò qui senza toccarlo.
 *
 * Le due asserzioni sono volutamente diverse per natura, e nessuna delle due è di scorta:
 *  · la prima fissa la CLASSE — `text-kidville-sub` presente, `text-kidville-muted`
 *    assente. È il difetto specifico (`muted` non è un inchiostro), ed è una tenaglia:
 *    qualunque ALTRO nome di token la fa cadere, `text-kidville-neutral` compreso, che
 *    pure vale lo stesso #7B8582;
 *  · la seconda fissa il VALORE, non il nome: rilegge da `globals.css` il token davvero
 *    scritto sul paragrafo e il fondo davvero sotto di esso, e ricalcola il rapporto sul
 *    posto. È l'unica delle due che si accorge di una modifica fatta LONTANO da qui: se
 *    un domani `--color-kidville-sub` venisse schiarito (o `--color-kidville-cream`
 *    scurito) fin sotto i 4,5:1, nessuno avrebbe toccato il componente, la prima
 *    resterebbe verde, e a diventare rossa sarebbe soltanto questa.
 *
 * Misurato, non dedotto: rimettendo `text-kidville-muted` alla riga 322 diventano rosse
 * ENTRAMBE, e con `text-kidville-neutral` diventano rosse entrambe lo stesso — la prima
 * sul nome, la seconda sul 3,43:1.
 */

// MensaCalendar importa (transitivamente, via fetchFigliIds) use-parent-identity, che a
// sua volta importa next/navigation. Il componente NON usa quegli hook: il mock rende
// l'import innocuo in jsdom (stesso mock dei due test gemelli del componente).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/parent/mensa',
}));

// Dexie non gira in jsdom (fake-indexeddb non è installato: vedi la nota in
// `__tests__/offline/read-cache.test.ts`). Mockando il solo store di lettura, la GET del
// menu può rispondere `ok: true` — cioè il percorso VERO dello stato vuoto: il server
// dice «questa settimana non ha giorni». Senza questo mock l'unico modo di ottenere la
// lista vuota sarebbe far FALLIRE la fetch (`fetchConCache` degrada e il componente
// ingoia con `.catch(() => null)`), e si finirebbe per collaudare un guasto di rete
// invece della risposta che i genitori vedono davvero.
vi.mock('@/lib/offline/db', () => ({
  db: {
    cache_read: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { MensaCalendar } from '@/components/features/parent/mensa/MensaCalendar';
import itMensa from '../../messages/it/mensa.json';

// Il testo si legge dal CATALOGO, non si congela qui: se un domani la frase cambia, il
// test segue la chiave invece di diventare rosso su una virgola.
const TESTO_STATO_VUOTO = (itMensa as Record<string, string>).nessunGiorno;

const RADICE = process.cwd();

// ── WCAG 2.x §1.4.3 — il rapporto di contrasto, ricalcolato qui ──────────────
// Nove righe di aritmetica pura, senza stato. La stessa matematica sta in
// `__tests__/a11y/contrasto-token.test.ts` e in `testo-muted-allowlist.test.ts`, che la
// ricopiano per la stessa ragione: importarla eseguirebbe i `describe` di quel file
// dentro questo, con i suoi test contati due volte.
const canale = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminanza = (hex: string) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b);
};
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)];
  const [alto, basso] = x > y ? [x, y] : [y, x];
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100;
};

/**
 * Il valore di un token come lo dichiara `@theme inline`. Si prende la PRIMA occorrenza
 * dopo l'apertura del blocco: più in basso `globals.css` ridichiara gli stessi nomi
 * dentro le regole di Alto Contrasto (`--color-kidville-cream: #000000`), che sono il
 * rimedio e non il valore di serie.
 */
function tokenTema(nome: string): string {
  const css = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8');
  const blocco = css.slice(css.indexOf('@theme inline'));
  const m = blocco.match(new RegExp(`--color-kidville-${nome}\\s*:\\s*(#[0-9A-Fa-f]{6})`));
  expect(m, `token --color-kidville-${nome} non trovato in globals.css`).toBeTruthy();
  return m![1].toUpperCase();
}

const fetchMock = vi.fn();

/** La settimana c'è, il server risponde, e di giorni non ce n'è nessuno. */
function menuSenzaGiorni() {
  return { ok: true, status: 200, json: async () => ({ success: true, data: [], meta: null }) };
}
/** Prenotazioni ok: saldo positivo, così non compare il banner «saldo esaurito». */
function prenOk() {
  return { status: 200, json: async () => ({ success: true, data: { saldo: 5, prenotazioni: [], cutoffOra: null } }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  // Il finto distingue per ENDPOINT: un mock che risponde uguale a qualunque URL
  // renderebbe verde anche un componente che chiama tutt'altro.
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/mensa/menu')) return Promise.resolve(menuSenzaGiorni());
    if (url.includes('/api/mensa/prenotazioni')) return Promise.resolve(prenOk());
    return Promise.reject(new Error(`URL non previsto in questo scenario: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
});

/** Rende il calendario e restituisce il paragrafo dello stato vuoto, a caricamento finito. */
async function paragrafoStatoVuoto(): Promise<HTMLElement> {
  render(<MensaCalendar userId="P1" studentId="S1" />);
  const p = await screen.findByText(TESTO_STATO_VUOTO, { exact: true });
  // È il <p> della riga 322, non un contenitore che lo ingloba…
  expect(p.tagName).toBe('P');
  // …ed è lo stato VUOTO, non quello di CARICAMENTO: lo spinner (role="status",
  // aria-busy) è sparito, quindi il ramo `giorni.length === 0` è quello reso.
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  return p;
}

describe('MensaCalendar — lo stato vuoto lo legge un genitore', () => {
  it('«nessun giorno» è scritto con `sub`, non con `muted`', async () => {
    const p = await paragrafoStatoVuoto();

    expect(
      p.className,
      '`muted` non è un inchiostro (globals.css:86-106): per il TESTO la destinazione è `sub`.',
    ).toContain('text-kidville-sub');
    expect(p.className).not.toContain('text-kidville-muted');
  });

  it('il suo inchiostro regge i 4,5:1 di WCAG 1.4.3 sul crema della shell genitore', async () => {
    const p = await paragrafoStatoVuoto();

    const m = p.className.match(/\btext-kidville-([a-z0-9-]+)\b/);
    expect(m, `nessuna classe text-kidville-* sul paragrafo: "${p.className}"`).toBeTruthy();

    const inchiostro = tokenTema(m![1]);
    // Il fondo è quello vero: la shell del genitore è `bg-kidville-cream`
    // (`src/app/(dashboard)/parent/layout.tsx:20`) e nessun contenitore la copre qui.
    const fondo = tokenTema('cream');
    const rapporto = contrasto(inchiostro, fondo);

    expect(
      rapporto,
      `text-kidville-${m![1]} (${inchiostro}) su crema (${fondo}) = ${rapporto}:1, sotto i 4,5:1 di WCAG 1.4.3.`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
