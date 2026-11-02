'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { SchedeVotazione } from '@/components/features/votazioni/genitore/SchedeVotazione';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

/**
 * LE VOTAZIONI DEI RAPPRESENTANTI, lato genitore: le schede aperte per le classi dei suoi figli e,
 * dove la segreteria l'ha chiesto, quella d'istituto della sede.
 *
 * Niente voce fissa di menu: ci si arriva dalla card in home (`VotazioniCard`), che compare solo quando
 * c'è qualcosa da votare. Il lavoro vero sta in `SchedeVotazione`; qui c'è solo l'identità di sessione
 * (URL → localStorage → `/api/me`, come ogni schermata genitore) e l'intestazione.
 *
 * `useSessionIdentity` e non `useParentIdentity`: alle votazioni serve chi sei, non quale figlio è
 * "attivo" — le schede si ricavano dal server per TUTTI i figli.
 */
function ParentVotazioniContent() {
  const t = useTranslations('votazioniGenitore');
  const { userId } = useSessionIdentity();

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow={t('eyebrowPagina')}
        title={t('titoloPagina')}
        subtitle={t('sottotitoloPagina')}
        className="mb-6"
      />
      <SchedeVotazione parentId={userId} />
    </div>
  );
}

export default function ParentVotazioniPage() {
  return (
    <Suspense fallback={
      <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
      </div>
    }>
      <ParentVotazioniContent />
    </Suspense>
  );
}
