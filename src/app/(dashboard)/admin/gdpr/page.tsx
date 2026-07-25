'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldAlert } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { OblioPanel } from '@/components/features/admin/settings/OblioPanel';
import { RichiesteCancellazionePanel } from '@/components/features/admin/settings/RichiesteCancellazionePanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

function GdprInner() {
  const { userId } = useSessionIdentity();
  const t = useTranslations('adminAltro');
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={ShieldAlert}
        eyebrow={t('eyebrowAmministrazione')}
        title={t('gdprTitle')}
        subtitle={t('gdprSubtitle')}
      />
      {userId && (
        <div className="space-y-8">
          <RichiesteCancellazionePanel userId={userId} />
          <OblioPanel userId={userId} />
        </div>
      )}
    </CockpitPage>
  );
}

export default function AdminGdprPage() {
  return (
    <Suspense fallback={null}>
      <GdprInner />
    </Suspense>
  );
}
