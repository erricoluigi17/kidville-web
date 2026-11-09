'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { ClipboardCheck } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { ConfermeClient } from './ConfermeClient';

/** Le conferme per l'anno prossimo (PR 4.5, compito 4.5.6). Il lavoro sta in `ConfermeClient`. */
export default function ConfermePage() {
  const t = useTranslations('annoConferme');
  return (
    <CockpitPage max={1152}>
      <PageHeader icon={ClipboardCheck} eyebrow={t('eyebrow')} title={t('titolo')} subtitle={t('sottotitolo')} />
      {/* `ConfermeClient` legge `useSearchParams`: senza questo confine la build non può preparare la pagina in statico. */}
      <Suspense fallback={null}>
        <ConfermeClient />
      </Suspense>
    </CockpitPage>
  );
}
