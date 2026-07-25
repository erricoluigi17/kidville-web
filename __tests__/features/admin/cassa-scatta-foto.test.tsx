import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * Rifinitura Fase 2 — il bottone native-only «Scatta foto» è cablato in un host
 * PRIORITARIO (giustificativo di cassa) che accetta anche PDF. Verifica che:
 *  · su web NON compaia (l'<input> file resta l'unico trigger, PDF intatto);
 *  · su nativo compaia e, allo scatto, la foto della fotocamera finisca nello
 *    STESSO stato che l'<input> popola (`setFile`) → il modal mostra «📷 <nome>».
 */

vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(),
  scegliFotoNativa: vi.fn(),
}));

import { CassaMovimentoModal } from '@/components/features/admin/pagamenti/CassaMovimentoModal';
import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera';

const mockDisponibile = vi.mocked(fotocameraNativaDisponibile);
const mockScegli = vi.mocked(scegliFotoNativa);

function renderModal() {
  return render(
    <CassaMovimentoModal
      userId="u1"
      scuolaId="s1"
      tipoIniziale="uscita"
      onClose={() => {}}
      onDone={() => {}}
    />,
  );
}

describe('CassaMovimentoModal — «Scatta foto» giustificativo (native-only, PDF intatto)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Le categorie di uscita sono caricate all'mount: stub fetch senza rete reale.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ categorie: [] }) }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('su WEB il bottone «Scatta foto» non compare; l’<input> file resta', async () => {
    mockDisponibile.mockReturnValue(false);
    renderModal();
    // L'input PDF/foto di sempre è presente…
    expect(document.getElementById('cassa-mov-foto')).toBeInTheDocument();
    // …ma nessun bottone fotocamera su web.
    expect(screen.queryByLabelText('Scatta foto')).toBeNull();
  });

  it('su NATIVO lo scatto popola lo stesso stato dell’input (mostra «📷 <nome>»)', async () => {
    mockDisponibile.mockReturnValue(true);
    const foto = new File([new Uint8Array([9])], 'scontrino-1.jpg', { type: 'image/jpeg' });
    mockScegli.mockResolvedValue([foto]);

    renderModal();
    // L'input PDF resta comunque (supporto documento intatto).
    expect(document.getElementById('cassa-mov-foto')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Scatta foto'));

    await waitFor(() => expect(mockScegli).toHaveBeenCalledTimes(1));
    // La foto della fotocamera è finita in `setFile` → il modal la mostra.
    await waitFor(() => expect(screen.getByText('📷 scontrino-1.jpg')).toBeInTheDocument());
  });
});
