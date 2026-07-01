'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { OblioPanel } from '@/components/features/admin/settings/OblioPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

const DEV_ADMIN = '22222222-2222-2222-2222-555555555555';

function GdprInner() {
  const userId = useSearchParams().get('userId') || DEV_ADMIN;
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={ShieldAlert}
        title="Privacy & Diritto all'Oblio"
        subtitle="Cancellazione (anonimizzazione) dei dati personali degli alunni non iscritti. Azione riservata alla Direzione."
      />
      <OblioPanel userId={userId} />
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
