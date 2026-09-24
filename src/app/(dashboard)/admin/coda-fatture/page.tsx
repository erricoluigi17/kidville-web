'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { ListOrdered } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { CodaFatturePanel } from '@/components/features/admin/pagamenti/CodaFatturePanel';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { PushOptIn } from '@/components/features/parent/pagamenti/PushOptIn';

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
        actions={
          userId ? (
            // Consegna 2c: gli avvisi della coda arrivano sul telefono, a PC spento, solo se questo
            // dispositivo è iscritto alla push — sul web e nell'app, dallo stesso pulsante. Allo staff
            // la push porta solo gli avvisi della coda e gli scarti SdI (il filtro sta nel dispatch).
            <PushOptIn
              userId={userId}
              etichette={{ attiva: t('codaFatturePushAttiva'), attive: t('codaFatturePushAttive') }}
            />
          ) : undefined
        }
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
