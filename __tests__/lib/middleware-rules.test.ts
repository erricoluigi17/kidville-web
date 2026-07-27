import { describe, it, expect } from 'vitest';
import { isPublicPath, isApiPath, shouldRedirect } from '@/lib/auth/middleware-rules';

describe('middleware-rules', () => {
  describe('isPublicPath', () => {
    it('treats auth, public enrollment and form links as public', () => {
      for (const p of [
        '/auth/login',
        '/auth/join',
        '/auth/reset',
        '/iscrizione',
        '/iscrizione/step-2',
        '/api/iscrizione',
        '/api/iscrizione/upload',
        '/api/forms/send-otp',
        '/api/panic-alert',
        '/forms/abc',
        '/onboarding',
        '/m/abc-token',
        '/api/public/forms/xyz',
        '/api/public/forms/xyz/submit',
        // Pagine legali/di supporto pubbliche (Privacy Policy URL / Support URL per lo store)
        '/privacy',
        '/termini',
        '/assistenza',
        // Pagina pubblica di cancellazione account (Google Play Data safety): niente login,
        // il prefisso copre anche la pagina di conferma via magic-link.
        '/cancellazione-account',
        '/cancellazione-account/conferma',
        // Il ripiego offline pre-cachato dal Service Worker: se non fosse
        // pubblica, `install` scaricherebbe il 307 verso il login invece della
        // pagina, e offline l'app mostrerebbe un redirect al posto del ripiego.
        '/offline',
      ]) {
        expect(isPublicPath(p), p).toBe(true);
      }
    });

    it('treats the root, dashboard areas and data APIs as NOT public', () => {
      // La radice `/` è un instradatore autenticato, non una landing pubblica.
      for (const p of ['/', '/parent', '/admin', '/teacher', '/segreteria', '/api/grades', '/api/pagamenti']) {
        expect(isPublicPath(p), p).toBe(false);
      }
    });

    it('does not let a lookalike prefix leak (/iscrizionefoo is not public)', () => {
      expect(isPublicPath('/iscrizionefoo')).toBe(false);
      expect(isPublicPath('/authentication')).toBe(false);
      expect(isPublicPath('/mx')).toBe(false);
      expect(isPublicPath('/models')).toBe(false);
      expect(isPublicPath('/privacyfoo')).toBe(false);
      expect(isPublicPath('/terminifoo')).toBe(false);
      expect(isPublicPath('/assistenzafoo')).toBe(false);
      expect(isPublicPath('/cancellazione-accountx')).toBe(false);
    });
  });

  describe('isApiPath', () => {
    it('detects API routes', () => {
      expect(isApiPath('/api/grades')).toBe(true);
      expect(isApiPath('/api')).toBe(true);
      expect(isApiPath('/parent')).toBe(false);
    });
  });

  describe('shouldRedirect', () => {
    it('redirects anonymous page navigations to protected areas (root included)', () => {
      expect(shouldRedirect('/', false)).toBe(true);
      expect(shouldRedirect('/parent', false)).toBe(true);
      expect(shouldRedirect('/admin/pagamenti', false)).toBe(true);
    });
    it('never redirects when a session exists', () => {
      expect(shouldRedirect('/', true)).toBe(false);
      expect(shouldRedirect('/parent', true)).toBe(false);
    });
    it('never redirects public pages', () => {
      expect(shouldRedirect('/auth/login', false)).toBe(false);
    });
    it('never redirects API routes (the gate returns 401 JSON instead)', () => {
      expect(shouldRedirect('/api/grades', false)).toBe(false);
    });
  });
});
