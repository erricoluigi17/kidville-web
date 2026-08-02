import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

import itAltro from '../../messages/it/adminAltro.json';
import enAltro from '../../messages/en/adminAltro.json';

// =============================================================================
// Registro dei protocolli — la riga che si apriva SOLO col mouse.
//
// LA MISURA (collaudo accessibilità, /admin/protocolli con utente di segreteria):
// il dettaglio di una registrazione si apriva da `<tr onClick>` e da nient'altro.
// Il `<tr>` non ha `role`, non ha `tabIndex`, non ha `onKeyDown`: non è un tab
// stop e non risponde a Invio/Spazio. Navigando con Tab il focus passava dai
// filtri al bottone «Timbrato» di ogni riga e poi alla paginazione — l'UNICO
// controllo raggiungibile nella riga scarica il PDF timbrato, non apre niente.
// Da tastiera il dettaglio di un protocollo (annullamento, verifica d'impronta,
// rettifica, note interne) era irraggiungibile. WCAG 2.1.1 Tastiera, livello A.
//
// LA SOLUZIONE è la STESSA già adottata su `StudentTable` nel ciclo precedente,
// e questo conta più del singolo fix: un `<button type="button">` vero dentro la
// cella, con un nome accessibile che dice QUALE registrazione apre, e il
// `<tr onClick>` lasciato dov'è come comodità del mouse. Non `role="button"` sul
// `<tr>`: una riga intera trasformata in bottone prende come nome tutto il suo
// contenuto (numero, data, oggetto, mittente, badge) e inghiotte i controlli che
// ci vivono dentro — qui il bottone del PDF. Così il repo ha UNA regola sola per
// «riga di tabella che apre un dettaglio», non due.
//
// Il lock di copertura che impedisce alla terza tabella di ripetere lo schema
// sta in `__tests__/architecture/righe-tabella-con-comando.test.ts`.
// =============================================================================

// ── Perché questo file rimpiazza il mock GLOBALE di next-intl ────────────────
// `test/setup.ts` mocka `t = (key) => messaggio`: i VALORI non arrivano nemmeno
// alla funzione, quindi ogni stringa interpolata resta letterale
// (`Apri la registrazione n. {numero}`). Con quel mock l'asserzione «il nome del
// comando dice QUALE protocollo apre» sarebbe una tautologia verde: tutti i
// bottoni avrebbero lo stesso identico nome. Qui si risolve contro i messaggi
// italiani veri e si interpola davvero.
vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, string>> = {
    adminAltro: (await import('../../messages/it/adminAltro.json')).default,
    shared: (await import('../../messages/it/shared.json')).default,
    etichette: (await import('../../messages/it/etichette.json')).default,
    common: (await import('../../messages/it/common.json')).default,
  };
  const risolvi = (ns: string | undefined, key: string): string =>
    (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key);
  /** Sottoinsieme ICU che serve a questa pagina: `{chiave}` e il ramo `other` dei plurali. */
  const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
    modello
      .replace(/\{(\w+),\s*plural,[^]*?other\s*\{([^{}]*)\}\s*\}/g, (_m, k: string, ramo: string) =>
        ramo.replace(/#/g, String(valori[k] ?? '')),
      )
      .replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero));
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori);
    return Object.assign(t, {
      rich: t,
      markup: t,
      raw: (key: string) => risolvi(ns, key),
      has: (key: string) => Boolean(ns && cataloghi[ns] && key in cataloghi[ns]),
    });
  };
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

const USER = 'aaaabbbb-1111-4111-8111-ffffffffffff';

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }));
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: USER, role: 'admin', ready: true }),
}));
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: USER, ruolo: 'admin', withUser: (h: string) => h }),
}));

import ProtocolliPage from '@/app/(dashboard)/admin/protocolli/page';

/** Registrazioni FINTE (mai dati veri: il registro contiene corrispondenza reale). */
const PROTOCOLLI = [
  {
    id: 'prot-1', anno: 2026, numero: 42, tipo: 'ingresso' as const,
    data_registrazione: '2026-03-04T09:30:00.000Z',
    oggetto: 'Comunicazione di prova numero uno', mittente: 'Ente Finto Uno', destinatario: null,
    mezzo: 'PEC', rif_prot_mittente: null, rif_data_mittente: null,
    impronta_sha256: 'a'.repeat(64), categoria_id: null, collegato_a_id: null,
    note_interne: null, emergenza: false, emergenza_dichiarata_il: null,
    annullata_at: null, annullo_motivo: null,
    file_nome_originale: 'documento-uno.pdf', allegati_descrizione: null,
    categoria: null, allegati: [],
  },
  {
    id: 'prot-2', anno: 2026, numero: 43, tipo: 'uscita' as const,
    data_registrazione: '2026-03-05T11:00:00.000Z',
    oggetto: 'Comunicazione di prova numero due', mittente: null, destinatario: 'Ente Finto Due',
    mezzo: 'Email', rif_prot_mittente: null, rif_data_mittente: null,
    impronta_sha256: 'b'.repeat(64), categoria_id: null, collegato_a_id: null,
    note_interne: null, emergenza: false, emergenza_dichiarata_il: null,
    annullata_at: null, annullo_motivo: null,
    file_nome_originale: 'documento-due.pdf', allegati_descrizione: null,
    categoria: null, allegati: [],
  },
];
const STATS = { totale: 2, ingresso: 1, uscita: 1, interno: 0, annullate: 0, ultimoNumero: 43 };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://localhost');
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (u.pathname.includes('/protocolli/categorie')) return json({ success: true, data: [] });
    // `?id=<uuid>` è il DETTAGLIO. Attenzione: cercare la sottostringa «id=»
    // aggancerebbe anche `userId=`, che c'è su ogni chiamata.
    const id = u.searchParams.get('id');
    if (id) return json({ success: true, data: PROTOCOLLI.find((p) => p.id === id) ?? null });
    return json({ success: true, data: PROTOCOLLI, stats: STATS });
  });
  vi.stubGlobal('fetch', fetchMock);
});

/** Le righe DATO della tabella del registro (il `<thead>` resta fuori). */
function righe(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('tbody tr'));
}

/** La sonda del tester: cosa, dentro questa riga, può ricevere il focus da tastiera. */
function focusabili(riga: HTMLElement): HTMLElement[] {
  return Array.from(
    riga.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  );
}

async function apriRegistro() {
  const utils = render(<ProtocolliPage />);
  await waitFor(() => expect(righe(utils.container)).toHaveLength(2));
  return utils;
}

// =============================================================================
describe('Protocolli · il dettaglio di una registrazione si apre da TASTIERA', () => {
  it('CONTROLLO POSITIVO: il mock i18n di questo file INTERPOLA davvero', async () => {
    const { container } = await apriRegistro();
    // `protStatRegistrazioni` = «Registrazioni {anno}»: se il mock ignorasse i
    // valori — come fa quello globale — qui resterebbe la graffa, e ogni
    // asserzione sui nomi accessibili di questo file sarebbe una tautologia.
    expect(screen.getByText(`Registrazioni ${new Date().getFullYear()}`)).toBeInTheDocument();
    const etichette = Array.from(container.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') ?? '');
    expect(etichette.filter((x) => x.includes('{')), 'un modello ICU non interpolato').toEqual([]);
  });

  it('CONTROLLO POSITIVO: la sonda vede le righe e il bottone del PDF timbrato', async () => {
    const { container } = await apriRegistro();
    for (const riga of righe(container)) {
      // Se domani il bottone «Timbrato» sparisse, l'asserzione sotto («più di un
      // comando nella riga») smetterebbe di misurare quello che crede.
      expect(within(riga).getByRole('button', { name: new RegExp(itAltro.protBtnTimbrato, 'i') })).toBeInTheDocument();
    }
  });

  it('ogni riga porta un comando FOCUSABILE che apre la registrazione (non solo il PDF)', async () => {
    const { container } = await apriRegistro();
    for (const riga of righe(container)) {
      // Prima della correzione: 1 — il solo bottone del PDF timbrato.
      expect(focusabili(riga).length, 'nella riga non c\'è nessun comando oltre al download').toBeGreaterThan(1);
    }

    // Il comando è un bottone NATIVO: Invio e Spazio li garantisce la
    // piattaforma, e `type="button"` gli impedisce di inviare un form.
    const comando = within(righe(container)[0]).getByRole('button', { name: /0000042\/2026/ });
    expect(comando.tagName).toBe('BUTTON');
    expect(comando.getAttribute('type')).toBe('button');

    // Ordine di tabulazione = ordine del DOM, purché nessuno usi un `tabindex`
    // positivo. Entrando nella riga si incontra prima il numero (che apre la
    // registrazione) e poi il download: è l'ordine di lettura della tabella.
    for (const riga of righe(container)) {
      const elementi = focusabili(riga);
      expect(elementi[0].getAttribute('aria-label') ?? '', 'il primo tab stop della riga non è il numero').toMatch(/\d{7}\/\d{4}/);
      expect(
        elementi.filter((e) => Number(e.getAttribute('tabindex') ?? '0') > 0),
        'un tabindex positivo scavalca l\'ordine del documento',
      ).toEqual([]);
    }
  });

  it('il comando apre DAVVERO il dettaglio di QUELLA registrazione', async () => {
    const { container } = await apriRegistro();
    fireEvent.click(within(righe(container)[1]).getByRole('button', { name: /0000043\/2026/ }));

    // Il drawer di dettaglio intitola con il numero: è la prova che si è aperta
    // la registrazione giusta, non la prima della lista.
    await waitFor(() => expect(screen.getByText('Prot. n. 0000043/2026')).toBeInTheDocument());
    const chiamate = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(chiamate.some((u) => u.includes('id=prot-2')), 'il dettaglio non ha nemmeno interrogato il server').toBe(true);
  });

  it('il nome del comando dice QUALE registrazione apre (WCAG 2.5.3 Label in Name)', async () => {
    const { container } = await apriRegistro();
    const comando = within(righe(container)[0]).getByRole('button', { name: /0000042\/2026/ });
    // Il testo VISIBILE (il numero di protocollo) deve stare dentro il nome
    // accessibile: «apri» e basta, ripetuto 200 volte, non distingue niente.
    expect(comando.textContent).toContain('0000042/2026');
    expect(comando.getAttribute('aria-label') ?? '(nessun aria-label)').toContain('0000042/2026');
  });

  it('il click sulla riga resta la comodità del MOUSE', async () => {
    const { container } = await apriRegistro();
    fireEvent.click(righe(container)[0]);
    await waitFor(() => expect(screen.getByText('Prot. n. 0000042/2026')).toBeInTheDocument());
  });

  it('il bottone del PDF timbrato non apre il dettaglio (il suo click non risale)', async () => {
    const { container } = await apriRegistro();
    fireEvent.click(within(righe(container)[0]).getByRole('button', { name: new RegExp(itAltro.protBtnTimbrato, 'i') }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('versione=timbrato'))).toBe(true));
    expect(screen.queryByText('Prot. n. 0000042/2026'), 'lo scarico del PDF ha aperto anche il drawer').not.toBeInTheDocument();
  });
});

// =============================================================================
// Stessa violazione (WCAG 2.1.1), altro percorso dello STESSO file: gli input
// che scelgono il documento da protocollare sono `className="hidden"`, cioè
// `display:none`. Un elemento con `display:none` non è nell'ordine di
// tabulazione e non si attiva con Invio: la protocollazione — la funzione per
// cui esiste questa pagina — si poteva avviare SOLO col mouse. Il collaudo non
// l'aveva visto perché la schermata è autenticata e il tester ha dichiarato
// BLOCCATA la prova da tastiera nel browser.
//
// Il pattern giusto è già in casa (`RiconciliazionePanel.tsx`, commento «A1»):
// un `<button>` vero che aziona l'input via ref, e l'input `sr-only`
// (`tabIndex={-1}`, `aria-hidden`) perché il comando è il bottone, non lui.
// =============================================================================
describe('Protocolli · il documento si sceglie anche da TASTIERA', () => {
  /**
   * Le due utility Tailwind che decidono la faccenda, replicate qui perché il
   * foglio di stile vero non entra in jsdom. Sono le definizioni standard:
   * `hidden` toglie l'elemento dal flusso E dal focus, `sr-only` lo nasconde
   * agli occhi lasciandolo nell'albero. Senza questo stile il test misurerebbe
   * una stringa di classi; con questo misura l'EFFETTO.
   */
  function conCssDiVisibilita() {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style id="kv-probe">.hidden{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}</style>',
    );
  }

  it('CONTROLLO POSITIVO: in jsdom la classe decide davvero il `display`', () => {
    conCssDiVisibilita();
    document.body.insertAdjacentHTML('beforeend', '<input id="p-h" class="hidden"><input id="p-s" class="sr-only">');
    expect(getComputedStyle(document.getElementById('p-h')!).display).toBe('none');
    expect(getComputedStyle(document.getElementById('p-s')!).display).not.toBe('none');
  });

  it('il passo «scegli il documento» ha un comando vero, e l\'input non è `display:none`', async () => {
    conCssDiVisibilita();
    const { container } = await apriRegistro();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnProtocolla, 'i') }));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input, 'il selettore del file non è nel documento').toBeTruthy();
    expect(
      getComputedStyle(input).display,
      '`display:none` toglie l\'input dall\'ordine di tabulazione: il documento si sceglie solo col mouse',
    ).not.toBe('none');

    // Il comando è il bottone «Sfoglia»: raggiungibile con Tab, attivabile con
    // Invio, e il suo click arriva davvero all'input.
    const sfoglia = screen.getByRole('button', { name: new RegExp(itAltro.protSfoglia, 'i') });
    const apri = vi.spyOn(input, 'click');
    fireEvent.click(sfoglia);
    expect(apri, 'il bottone non apre il selettore di file').toHaveBeenCalledTimes(1);
  });

  it('«Sostituisci file» nel dettaglio è un comando, non un\'etichetta muta', async () => {
    conCssDiVisibilita();
    const { container } = await apriRegistro();
    fireEvent.click(within(righe(container)[0]).getByRole('button', { name: /0000042\/2026/ }));
    await waitFor(() => expect(screen.getByText('Prot. n. 0000042/2026')).toBeInTheDocument());

    const sostituisci = screen.getByRole('button', { name: new RegExp(itAltro.protSostituisciFile, 'i') });
    const input = sostituisci.parentElement!.querySelector<HTMLInputElement>('input[type="file"]')
      ?? container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    expect(getComputedStyle(input).display).not.toBe('none');
    const apri = vi.spyOn(input, 'click');
    fireEvent.click(sostituisci);
    expect(apri).toHaveBeenCalledTimes(1);
  });

  it('nel sorgente non resta un solo `input type="file"` nascosto con `hidden`', () => {
    const sorgente = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(dashboard)/admin/protocolli/page.tsx'),
      'utf8',
    );
    const input = sorgente.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
    // Tre: documento principale, allegato, sostituzione del file (admin).
    expect(input.length, 'la sonda non trova più gli input file: aggiorna il test').toBe(3);
    expect(
      input.filter((x) => /className="[^"]*\bhidden\b/.test(x)),
      '`hidden` è `display:none`: l\'input esce dall\'ordine di tabulazione (WCAG 2.1.1)',
    ).toEqual([]);
    expect(input.every((x) => x.includes('sr-only'))).toBe(true);
  });
});

// =============================================================================
describe('Protocolli · gli esiti si sentono, non solo si vedono', () => {
  it('il messaggio a comparsa è una live region (WCAG 4.1.3)', async () => {
    const { container } = await apriRegistro();
    // Il toast dice «Download non riuscito», «Registrazione annullata»,
    // «Documento sostituito»: senza `role="status"` uno screen reader non lo
    // annuncia, e l'unico riscontro dell'operazione è visivo.
    fireEvent.click(within(righe(container)[0]).getByRole('button', { name: new RegExp(itAltro.protBtnTimbrato, 'i') }));
    await waitFor(() => expect(screen.getByText(itAltro.protDownloadFallito)).toBeInTheDocument());
    const toast = screen.getByText(itAltro.protDownloadFallito);
    expect(toast.closest('[role="status"]'), 'il messaggio a comparsa non è annunciato').not.toBeNull();
  });
});

// =============================================================================
describe('Protocolli · i18n della chiave nuova', () => {
  it('`protApriDettaglio` esiste in ENTRAMBI i cataloghi e porta il numero', () => {
    expect(itAltro).toHaveProperty('protApriDettaglio');
    expect(enAltro).toHaveProperty('protApriDettaglio');
    expect((itAltro as Record<string, string>).protApriDettaglio).toContain('{numero}');
    expect((enAltro as Record<string, string>).protApriDettaglio).toContain('{numero}');
  });

  it('adminAltro: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(itAltro).sort()).toEqual(Object.keys(enAltro).sort());
  });
});
