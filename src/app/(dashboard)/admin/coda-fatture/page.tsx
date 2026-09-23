'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { ListOrdered } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { CodaFatturePanel } from '@/components/features/admin/pagamenti/CodaFatturePanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

/**
 * Pagina «Coda fatture» (nucleo §4). Tutta la segreteria, tutte le sedi
 * (decisione 6 del nucleo: niente `SedeRequired` qui, a differenza del resto
 * di Contabilità — il pannello LEGGE tutte le sedi insieme, ma «Togli»/«Rimetti» agiscono
 * solo sulle voci delle sedi dell'utente: `/coda/azioni` rifiuta le altre con 403).
 */
function CodaFattureInner() {
  const { userId, role } = useSessionIdentity();
  const t = useTranslations('adminContabilita');
  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={ListOrdered}
        eyebrow={t('pagPageEyebrow')}
        title={t('codaFatture.titolo')}
        subtitle={t('codaFatture.sottotitolo')}
      />
      {userId && <CodaFatturePanel userId={userId} ruolo={role} />}
    </CockpitPage>
  );
}

export default function AdminCodaFatturePage() {
  return (
    <Suspense fallback={null}>
      <CodaFattureInner />
    </Suspense>
  );
}
