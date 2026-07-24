'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Building2 } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SchoolsPanel } from '@/components/features/admin/settings/SchoolsPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

function SchoolsInner() {
  const t = useTranslations('adminSettings');
  const { userId } = useSessionIdentity();
  return (
    <CockpitPage max={1100}>
      <PageHeader eyebrow={t('sistemaEyebrow')} icon={Building2} title={t('multiSedeTitolo')} subtitle={t('multiSedeSottotitolo')} />
      {userId && <SchoolsPanel userId={userId} />}
    </CockpitPage>
  );
}

export default function AdminSchoolsPage() {
  return (
    <Suspense fallback={null}>
      <SchoolsInner />
    </Suspense>
  );
}
