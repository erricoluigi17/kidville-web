import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MediaGrid, type MediaItem } from '@/components/features/gallery/MediaGrid';
import itShared from '../../messages/it/shared.json';

// Bucket `gallery` privato: `file_url` arriva dalla GET già FIRMATO. Quando la
// firma non riesce (storage irraggiungibile, file cancellato a mano) la route
// risponde `file_url: null` e lo logga a livello `error` — qui si verifica che
// il difetto NON diventi un'immagine rotta muta: la card resta, con un
// segnaposto leggibile, e le azioni che senza indirizzo non possono funzionare
// (scarica, condividi) non si mostrano affatto.

const t = (k: string) => (itShared as Record<string, string>)[k];

const base: MediaItem = {
  id: 'm1',
  file_url: 'https://firmato.test/uploads/a.jpg',
  file_type: 'foto',
  caption: 'Gita al parco',
  tag_students: [],
  is_broadcast: false,
  created_at: new Date().toISOString(),
  uploader_name: 'Maestra Ada',
};

describe('MediaGrid — media senza indirizzo utilizzabile', () => {
  it('con il link firmato mostra la foto', () => {
    render(<MediaGrid items={[base]} showActions />);
    const img = screen.getByAltText('Gita al parco') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://firmato.test/uploads/a.jpg');
  });

  it('senza link non produce MAI un <img> con src vuoto', () => {
    const { container } = render(<MediaGrid items={[{ ...base, file_url: null }]} showActions />);
    const immagini = [...container.querySelectorAll('img')];
    // `<img src="">` fa ripartire una richiesta sulla pagina stessa e mostra
    // l'icona di immagine rotta: il segnaposto è preferibile.
    for (const img of immagini) expect(img.getAttribute('src')).toBeTruthy();
    expect(screen.getAllByText(t('galleryAnteprimaNonDisponibile')).length).toBeGreaterThan(0);
  });

  it('senza link non mostra i pulsanti Scarica/Condividi (non potrebbero funzionare)', () => {
    render(<MediaGrid items={[{ ...base, file_url: null }]} showActions />);
    expect(screen.queryByTitle(t('mediaScarica'))).toBeNull();
    expect(screen.queryByTitle(t('mediaCondividi'))).toBeNull();
  });

  it('con il link i pulsanti Scarica/Condividi restano', () => {
    render(<MediaGrid items={[base]} showActions />);
    expect(screen.getByTitle(t('mediaScarica'))).toBeTruthy();
    expect(screen.getByTitle(t('mediaCondividi'))).toBeTruthy();
  });

  it('la didascalia e il resto della card restano leggibili anche senza foto', () => {
    render(<MediaGrid items={[{ ...base, file_url: null }]} showActions />);
    expect(screen.getAllByText('Gita al parco').length).toBeGreaterThan(0);
  });
});
