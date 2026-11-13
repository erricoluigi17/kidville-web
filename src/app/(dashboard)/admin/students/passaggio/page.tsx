'use client';

import { useTranslations } from 'next-intl';
import { CalendarCheck } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { PassaggioClient } from './PassaggioClient';

/** Il passaggio d'anno (PR 4.8, compito 4.8.9). Come «Conferme», la pagina è solo l'intestazione: il lavoro sta in `PassaggioClient`. */
export default function PassaggioPage() {
  const t = useTranslations('annoPassaggio');
  return (
    <CockpitPage max={1152}>
      <PageHeader icon={CalendarCheck} eyebrow={t('eyebrow')} title={t('titolo')} subtitle={t('sottotitolo')} />
      <PassaggioClient />
    </CockpitPage>
  );
}
