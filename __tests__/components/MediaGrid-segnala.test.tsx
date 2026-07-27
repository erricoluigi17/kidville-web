import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MediaGrid, MediaItem } from '@/components/features/gallery/MediaGrid';

const item: MediaItem = {
  id: 'm1',
  file_url: 'https://esempio.test/foto.jpg',
  file_type: 'image',
  caption: 'Gita al parco',
  tag_students: [],
  is_broadcast: true,
  created_at: new Date().toISOString(),
  uploader_name: 'Maestra Anna',
};

// C5 §2 — segnalazione media in galleria. La voce "Segnala foto/video" vive nel
// lightbox, solo lato genitore (showActions), sempre con etichetta testuale.
describe('MediaGrid — segnalazione (lato genitore)', () => {
  it('mostra "Segnala foto/video" con testo nel lightbox quando showActions', () => {
    render(<MediaGrid items={[item]} showActions />);
    // Apre il lightbox cliccando la card (l'immagine ha alt = caption).
    fireEvent.click(screen.getByAltText('Gita al parco'));
    const btn = screen.getByRole('button', { name: /Segnala foto\/video/ });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('Segnala foto/video');
  });

  it('NON mostra la segnalazione quando showActions è assente (lato staff)', () => {
    render(<MediaGrid items={[item]} />);
    fireEvent.click(screen.getByAltText('Gita al parco'));
    expect(screen.queryByRole('button', { name: /Segnala foto\/video/ })).toBeNull();
  });
});
