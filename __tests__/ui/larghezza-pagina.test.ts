import { describe, it, expect } from 'vitest';
import {
  classeColonnaGenitore,
  colonneGalleria,
  COLONNA_DOCENTE,
  COLONNA_DOCENTE_LARGA,
  DUE_COLONNE,
  GRIGLIA_BAMBINI,
  ROTTE_LARGHE_GENITORE,
} from '@/lib/ui/larghezza-pagina';

describe('larghezza-pagina — le colonne di genitori e docenti', () => {
  it('il genitore resta a 430 px sul telefono e sale a 720 da tablet', () => {
    expect(classeColonnaGenitore('/parent/diary')).toBe('max-w-[430px] tablet:max-w-[720px]');
    expect(classeColonnaGenitore('/parent/locker')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });

  it('le rotte larghe si allargano, sottorotte comprese', () => {
    expect(ROTTE_LARGHE_GENITORE).toContain('/parent/chat');
    expect(classeColonnaGenitore('/parent/chat')).toBe('max-w-[430px] tablet:max-w-5xl');
    expect(classeColonnaGenitore('/parent/chat/abc')).toBe('max-w-[430px] tablet:max-w-5xl');
  });

  it('un prefisso che somiglia non basta', () => {
    expect(classeColonnaGenitore('/parent/chatbot')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });

  it('la home del genitore è larga, ma non allarga per prefisso tutta l’area', () => {
    expect(classeColonnaGenitore('/parent')).toBe('max-w-[430px] tablet:max-w-5xl');
    expect(classeColonnaGenitore('/parent/diary')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });

  it('le schermate su più colonne del genitore sono larghe, le loro pagine di lettura no', () => {
    for (const r of ['/parent/gallery', '/parent/mensa', '/parent/pagamenti', '/parent/avvisi', '/parent/news']) {
      expect(classeColonnaGenitore(r), r).toBe('max-w-[430px] tablet:max-w-5xl');
    }
    // Il dettaglio di una news e il digest sono testo da leggere: restano nella colonna da 720.
    for (const r of ['/parent/news/abc', '/parent/news/digest', '/parent/news/digest/abc']) {
      expect(classeColonnaGenitore(r), r).toBe('max-w-[430px] tablet:max-w-[720px]');
    }
  });

  it('il docente resta a 460 px sul telefono e sale a 720 da tablet', () => {
    expect(COLONNA_DOCENTE).toBe('mx-auto max-w-[460px] tablet:max-w-[720px]');
  });

  it('il docente ha anche la colonna larga, per le schermate su più colonne', () => {
    expect(COLONNA_DOCENTE_LARGA).toBe('mx-auto max-w-[460px] tablet:max-w-5xl');
  });

  it('la galleria: 2 colonne sul telefono, 3 sul binario, 4 con la sidebar', () => {
    expect(colonneGalleria('telefono')).toBe(2);
    expect(colonneGalleria('binario')).toBe(3);
    expect(colonneGalleria('sidebar')).toBe(4);
  });

  it('le due colonne si accendono solo da 1024 px, dove compare la sidebar', () => {
    // Se qualcuno sposta il punto a `tablet:` o `md:`, le colonne da ~330 px del binario
    // stringono schede pensate per 390.
    expect(DUE_COLONNE).toBe('grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start');
    expect(GRIGLIA_BAMBINI).toBe('grid grid-cols-1 gap-2 lg:grid-cols-2 lg:items-start');
  });

  it('sul telefono la colonna è DICHIARATA, non la colonna `auto` implicita della griglia', () => {
    // Una colonna `auto` non scende sotto il min-content delle schede: il 2026-11-05 il motivo
    // d'assenza di un genitore (194 caratteri, `truncate`) ha allargato a ~1.200 px tutte le righe
    // dell'appello, e i bottoni Presente/Assente sono finiti fuori dallo schermo. `grid-cols-1` è
    // `minmax(0, 1fr)`: il minimo è 0 e la scheda resta larga quanto lo schermo.
    for (const griglia of [DUE_COLONNE, GRIGLIA_BAMBINI]) {
      const classi = griglia.split(' ');
      expect(classi).toContain('grid');
      expect(classi).toContain('grid-cols-1');
    }
  });
});
