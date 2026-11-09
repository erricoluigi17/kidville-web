'use client';

import { useTranslations } from 'next-intl';
import { LayoutDashboard } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { CruscottoClient } from './CruscottoClient';

/** Il cruscotto dell'anno prossimo (PR 4.7, compito 4.7.3). Il lavoro sta in `CruscottoClient`. */
export default function AnnoProssimoPage() {
  const t = useTranslations('annoCruscotto');
  return (
    <CockpitPage max={1152}>
      <PageHeader icon={LayoutDashboard} eyebrow={t('eyebrow')} title={t('titolo')} subtitle={t('sottotitolo')} />
      <CruscottoClient />
    </CockpitPage>
  );
}
