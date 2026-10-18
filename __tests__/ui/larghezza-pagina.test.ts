import { describe, it, expect } from 'vitest';
import {
  classeColonnaGenitore,
  COLONNA_DOCENTE,
  ROTTE_LARGHE_GENITORE,
} from '@/lib/ui/larghezza-pagina';

describe('larghezza-pagina — le colonne di genitori e docenti', () => {
  it('il genitore resta a 430 px sul telefono e sale a 720 da tablet', () => {
    expect(classeColonnaGenitore('/parent')).toBe('max-w-[430px] tablet:max-w-[720px]');
    expect(classeColonnaGenitore('/parent/mensa')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });

  it('le rotte larghe si allargano, sottorotte comprese', () => {
    expect(ROTTE_LARGHE_GENITORE).toContain('/parent/chat');
    expect(classeColonnaGenitore('/parent/chat')).toBe('max-w-[430px] tablet:max-w-5xl');
    expect(classeColonnaGenitore('/parent/chat/abc')).toBe('max-w-[430px] tablet:max-w-5xl');
  });

  it('un prefisso che somiglia non basta', () => {
    expect(classeColonnaGenitore('/parent/chatbot')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });

  it('il docente resta a 460 px sul telefono e sale a 720 da tablet', () => {
    expect(COLONNA_DOCENTE).toBe('mx-auto max-w-[460px] tablet:max-w-[720px]');
  });
});
