'use client';

import { useTranslations } from 'next-intl';

/** Al posto di un importo quando le cifre sono nascoste: «••••» per gli occhi, una frase per lo screen reader. */
export function CifraNascosta() {
  const t = useTranslations('adminContabilita');
  return (
    <>
      <span aria-hidden="true">••••</span>
      <span className="sr-only">{t('dashCifraNascosta')}</span>
    </>
  );
}
