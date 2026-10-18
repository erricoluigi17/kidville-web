'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { UserCheck } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { CandidatureInsegnanti } from '@/components/features/admin/iscrizioni/CandidatureInsegnanti';

/**
 * Le candidature «Lavora con noi», in una pagina propria (dal 2026-10-17).
 *
 * Prima erano la quarta linguetta di Modulistica: centinaia di curriculum da scorrere ogni
 * settimana, dentro una schermata che parla di moduli per le famiglie. Il vecchio indirizzo
 * `/admin/modulistica?tab=candidature` rimanda qui (`redirects()` in `next.config.ts`).
 *
 * Multi-sede come prima: il pannello dichiara le sedi attive con `x-sedi` e non passa dalla
 * guardia di sede singola. Il `Suspense` serve a `useFiltri`, che legge `useSearchParams`.
 */
function CandidatureInner() {
  const t = useTranslations('adminAltro');
  return (
    <CockpitPage>
      <PageHeader
        icon={UserCheck}
        eyebrow={t('eyebrowAmministrazione')}
        title={t('candPageTitolo')}
        subtitle={t('candPageSottotitolo')}
      />
      <CandidatureInsegnanti />
    </CockpitPage>
  );
}

export default function AdminCandidaturePage() {
  return (
    <Suspense fallback={null}>
      <CandidatureInner />
    </Suspense>
  );
}
