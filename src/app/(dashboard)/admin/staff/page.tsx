'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Users } from 'lucide-react';
import { StaffPanel } from '@/components/features/admin/settings/StaffPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function StaffInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN;
  return (
    <CockpitPage max={1100}>
      <PageHeader icon={Users} title="Gestione Staff" subtitle="Ruoli, sede e classi del personale. Azione riservata alla Direzione." />
      <StaffPanel userId={userId} />
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
