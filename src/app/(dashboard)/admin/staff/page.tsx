'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { StaffPanel } from '@/components/features/admin/settings/StaffPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

function StaffInner() {
  const { userId } = useSessionIdentity();
  const t = useTranslations('adminStudents');
  return (
    <CockpitPage max={1100}>
      <PageHeader icon={Users} title={t('staffPageTitolo')} subtitle={t('staffPageSottotitolo')} />
      {userId && <StaffPanel userId={userId} />}
    </CockpitPage>
  );
}

export default function AdminStaffPage() {
  return (
    <Suspense fallback={null}>
      <StaffInner />
    </Suspense>
  );
}
