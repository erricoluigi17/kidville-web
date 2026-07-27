import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SegnalaContenuto } from '@/components/features/segnalazioni/SegnalaContenuto';

// Trigger + dialog di segnalazione contenuto, condiviso tra galleria e diario.
// La label del bottone è passata dal chiamante (namespace i18n del contesto),
// il dialog usa la propria chrome. POST /api/segnalazioni con tipo_oggetto +
// oggetto_id. Il `motivo` è testo libero: MAI loggato in chiaro.
describe('SegnalaContenuto', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mostra un bottone con etichetta testuale visibile (mai solo icona)', () => {
    render(<SegnalaContenuto tipoOggetto="media_galleria" oggettoId="m1" label="Segnala foto/video" />);
    const btn = screen.getByRole('button', { name: /Segnala foto\/video/ });
    expect(btn).toBeInTheDocument();
    // Etichetta testuale presente nel contenuto del bottone.
    expect(btn).toHaveTextContent('Segnala foto/video');
  });

  it('cliccando apre il dialog di segnalazione', () => {
    render(<SegnalaContenuto tipoOggetto="voce_diario" oggettoId="v1" label="Segnala" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Segnala' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('invia con tipo_oggetto, oggetto_id e categoria; NON manda il motivo se vuoto', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<SegnalaContenuto tipoOggetto="media_galleria" oggettoId="media-123" label="Segnala foto/video" />);
    fireEvent.click(screen.getByRole('button', { name: /Segnala foto\/video/ }));
    fireEvent.click(screen.getByRole('button', { name: /Invia segnalazione/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/segnalazioni');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.tipo_oggetto).toBe('media_galleria');
    expect(body.oggetto_id).toBe('media-123');
    expect(body.categoria).toBeTruthy();
    // Motivo lasciato vuoto → chiave assente (non stringa vuota).
    expect(body.motivo).toBeUndefined();
  });

  it('dopo un invio riuscito mostra la conferma', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<SegnalaContenuto tipoOggetto="voce_diario" oggettoId="v1" label="Segnala" />);
    fireEvent.click(screen.getByRole('button', { name: 'Segnala' }));
    fireEvent.click(screen.getByRole('button', { name: /Invia segnalazione/ }));

    await waitFor(() =>
      expect(screen.getByText(/Segnalazione inviata/)).toBeInTheDocument(),
    );
  });

  it('su errore del server resta il form e mostra un messaggio', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'x' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<SegnalaContenuto tipoOggetto="voce_diario" oggettoId="v1" label="Segnala" />);
    fireEvent.click(screen.getByRole('button', { name: 'Segnala' }));
    fireEvent.click(screen.getByRole('button', { name: /Invia segnalazione/ }));

    await waitFor(() =>
      expect(screen.getByText(/Non è stato possibile inviare/)).toBeInTheDocument(),
    );
    // Il form è ancora lì per riprovare.
    expect(screen.getByRole('button', { name: /Invia segnalazione/ })).toBeInTheDocument();
  });
});
