'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Flag } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SegnalazioniPanel } from '@/components/features/admin/moderazione/SegnalazioniPanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

// Pannello Direzione per la moderazione dell'UGC (C5 §2): coda delle segnalazioni
// (contenuto/utente) ricevute da genitori e staff. Le conversazioni sospese si
// riaprono dalla supervisione chat (Messaggi → «Tutti i messaggi»).
function ModerazioneInner() {
  const { userId } = useSessionIdentity();
  const t = useTranslations('adminAltro');
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={Flag}
        eyebrow={t('eyebrowAmministrazione')}
        title={t('modTitle')}
        subtitle={t('modSubtitle')}
      />
      {userId && <SegnalazioniPanel userId={userId} />}
    </CockpitPage>
  );
}

export default function AdminModerazionePage() {
  return (
    <Suspense fallback={null}>
      <ModerazioneInner />
    </Suspense>
  );
}
