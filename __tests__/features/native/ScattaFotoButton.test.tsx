import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * Bottone NATIVE-ONLY «Scatta foto» (rifinitura Fase 2). Additivo: si affianca a
 * un <input type=file> che accetta anche PDF/doc, SENZA sostituirlo. Deve:
 *  · non rendere NULLA su web (il drop-zone/input di sempre resta l'unico trigger);
 *  · comparire su nativo con `aria-label="Scatta foto"` (a11y);
 *  · al click aprire la fotocamera (`scegliFotoNativa`) e consegnare OGNI File
 *    scelto allo STESSO handler dell'host (la prop `onFile`);
 *  · non chiamare l'handler se l'utente ANNULLA (fotocamera → []).
 */

vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(),
  scegliFotoNativa: vi.fn(),
}));

import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera';

const mockDisponibile = vi.mocked(fotocameraNativaDisponibile);
const mockScegli = vi.mocked(scegliFotoNativa);

describe('ScattaFotoButton — native-only, additivo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('su WEB non rende nulla (nessun bottone «Scatta foto»)', () => {
    mockDisponibile.mockReturnValue(false);
    const onFile = vi.fn();
    render(<ScattaFotoButton onFile={onFile} label="Scatta foto" />);
    expect(screen.queryByLabelText('Scatta foto')).toBeNull();
  });

  it('su NATIVO rende il bottone con aria-label «Scatta foto»', () => {
    mockDisponibile.mockReturnValue(true);
    mockScegli.mockResolvedValue([]);
    const onFile = vi.fn();
    render(<ScattaFotoButton onFile={onFile} label="Scatta foto" />);
    expect(screen.getByLabelText('Scatta foto')).toBeInTheDocument();
  });

  it('al click apre la fotocamera e passa il File all’handler dell’host', async () => {
    mockDisponibile.mockReturnValue(true);
    const foto = new File([new Uint8Array([1, 2, 3])], 'foto-123.jpg', { type: 'image/jpeg' });
    mockScegli.mockResolvedValue([foto]);
    const onFile = vi.fn();
    render(<ScattaFotoButton onFile={onFile} label="Scatta foto" />);

    fireEvent.click(screen.getByLabelText('Scatta foto'));

    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));
    expect(mockScegli).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(foto);
  });

  it('se l’utente annulla (fotocamera → []) NON chiama l’handler', async () => {
    mockDisponibile.mockReturnValue(true);
    mockScegli.mockResolvedValue([]);
    const onFile = vi.fn();
    render(<ScattaFotoButton onFile={onFile} label="Scatta foto" />);

    fireEvent.click(screen.getByLabelText('Scatta foto'));

    await waitFor(() => expect(mockScegli).toHaveBeenCalledTimes(1));
    expect(onFile).not.toHaveBeenCalled();
  });
});
