'use client';

import { useLocale, useTranslations } from 'next-intl';
import { LOCALE_COOKIE, LOCALES, type Locale } from '@/i18n/config';
import { cx } from '@/lib/ui/cx';

// Applica la lingua: scrive il cookie KV_LOCALE e ricarica, così il request-config
// server-side rilegge lingua e messaggi. Funzione a livello di modulo (fuori dal
// componente) perché muta `document.cookie`/`window` — non consentito nel corpo di
// un componente dalla regola react-hooks/immutability.
function applicaLingua(l: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  window.location.reload();
}

// Selettore lingua (IT/EN). Nessuna dipendenza dal routing: funziona ovunque.
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale() as Locale;
  const t = useTranslations('common');

  return (
    <div
      className={cx('inline-flex items-center gap-1 rounded-pill bg-kidville-neutral-soft p-1', className)}
      role="group"
      aria-label={t('lingua')}
    >
      {LOCALES.map((l) => {
        const attivo = l === locale;
        return (
          <button
            key={l}
            type="button"
            onClick={() => { if (!attivo) applicaLingua(l); }}
            aria-pressed={attivo}
            className={cx(
              'rounded-pill px-3 py-1 font-barlow text-xs font-bold uppercase tracking-wide transition-colors',
              attivo ? 'bg-kidville-green text-white' : 'text-kidville-sub hover:text-kidville-green',
            )}
          >
            {l === 'it' ? t('italiano') : t('inglese')}
          </button>
        );
      })}
    </div>
  );
}
