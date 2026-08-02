import { describe, it, expect } from 'vitest';
import { allegatoMostrabile } from '@/components/features/chat/ChatMessageArea';

// S32 — da quando `chat_messages.attachment_url` contiene il PERCORSO nel bucket
// privato (e non più un link firmato a 365 giorni), esiste una finestra in cui
// la bolla riceve il percorso grezzo: il Realtime di Supabase consegna la riga
// del database così com'è, senza passare dalle route che firmano.
//
// Un percorso dentro un `<img src>` è un'immagine rotta — e «la chat è rotta» è
// esattamente la conclusione sbagliata che si trae guardandola. La bolla mostra
// l'allegato solo quando ha in mano un indirizzo che il browser può davvero
// aprire; per il resto ci pensa il ricarico (che firma).
describe('allegatoMostrabile — si mostra solo ciò che il browser può aprire', () => {
  it('un link firmato dello Storage si mostra', () => {
    expect(
      allegatoMostrabile('https://abc.supabase.co/storage/v1/object/sign/chat-allegati/u/a.pdf?token=T'),
    ).toBe(true);
  });

  it('un PERCORSO nel bucket non si mostra (arriva dal Realtime, non è un indirizzo)', () => {
    expect(allegatoMostrabile('aaaaaaaa-0000-4000-8000-000000000001/abc-referto.pdf')).toBe(false);
  });

  it('niente allegato, niente da mostrare', () => {
    expect(allegatoMostrabile(null)).toBe(false);
    expect(allegatoMostrabile('')).toBe(false);
  });

  it('uno schema non-http non si mostra (era già la regola per i documenti)', () => {
    expect(allegatoMostrabile('javascript:alert(1)')).toBe(false);
    expect(allegatoMostrabile('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });
});
