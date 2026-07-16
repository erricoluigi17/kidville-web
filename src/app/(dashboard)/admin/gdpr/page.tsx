'use client';

import { Suspense } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { OblioPanel } from '@/components/features/admin/settings/OblioPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

function GdprInner() {
  const { userId } = useSessionIdentity();
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={ShieldAlert}
        eyebrow="Amministrazione"
        title="Privacy & Diritto all'Oblio"
        subtitle="Cancellazione (anonimizzazione) dei dati personali degli alunni non iscritti. Azione riservata alla Direzione."
      />
      {userId && <OblioPanel userId={userId} />}
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
