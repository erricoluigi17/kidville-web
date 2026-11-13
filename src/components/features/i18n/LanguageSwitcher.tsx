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
// ⚠️ Nella login (`auth/login/page.module.css`, `--kv-testa-login`) lo spazio sotto questa pill è
// 36px, calcolato su un'altezza di ~32px (`p-1` + `py-1 text-xs`). Se la pill diventa più alta,
// quel 36 va rivisto: lo guarda il lock `login-pill-lingua-sotto-safe-area`. L'area di tocco (44px) è un pseudo-elemento
// che sporge di ~10px sopra e sotto ogni pulsante: non cambia la pill a vista né lo spazio riservato al logo
// (il logo non è interattivo, e il pseudo-elemento sporge al massimo di 2px sulla sua fascia).
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
              'relative rounded-pill px-3 py-1 font-barlow text-xs font-bold uppercase tracking-wide transition-colors',
              // Area di tocco di 44px (h-11 fissi, non dipendono dal font) senza far crescere la pill a vista.
              'before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-[\'\']',
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
