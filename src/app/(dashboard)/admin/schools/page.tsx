'use client';

import { Suspense } from 'react';
import { Building2 } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SchoolsPanel } from '@/components/features/admin/settings/SchoolsPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

function SchoolsInner() {
  const { userId } = useSessionIdentity();
  return (
    <CockpitPage max={1100}>
      <PageHeader eyebrow="Sistema" icon={Building2} title="Multi-Sede" subtitle="Aggiungi, rinomina o disattiva le sedi. Azione riservata alla Direzione." />
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
