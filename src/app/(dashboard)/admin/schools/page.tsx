'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { SchoolsPanel } from '@/components/features/admin/settings/SchoolsPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function SchoolsInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN;
  return (
    <CockpitPage max={1100}>
      <PageHeader icon={Building2} title="Multi-Sede" subtitle="Aggiungi, rinomina o disattiva le sedi. Azione riservata alla Direzione." />
      <SchoolsPanel userId={userId} />
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
