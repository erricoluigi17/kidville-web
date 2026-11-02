'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Vote } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { SedeRequired } from '@/lib/context/sede-context';
import { VotazioniShell } from '@/components/features/votazioni/admin/VotazioniShell';

/**
 * Le votazioni dei rappresentanti (`/admin/votazioni`): la segreteria apre la votazione dei rappresentanti di
 * classe e, se serve, di quello d'istituto; i genitori votano dall'app. Piano:
 * `docs/superpowers/plans/2026-11-02-votazioni-rappresentanti.md` (Task 7).
 *
 * La sede è OBBLIGATORIA e UNA sola: `SedeRequired` rende la schermata solo quando c'è una sede risolta — la
 * propria per la segreteria, quella scelta per l'admin con più plessi, che altrimenti vede l'invito a sceglierne
 * una. Fino ad allora non parte nessuna richiesta: con tre sedi in produzione una schermata che «sceglie da
 * sola» aprirebbe la votazione nel plesso sbagliato, in silenzio (AGENTS.md, Note). `key={scuolaId}` rimonta la
 * schermata al cambio di sede: né l'elenco né un pannello aperto restano della sede di prima.
 *
 * Il `Suspense` serve a `VotazioniShell`, che legge `useSearchParams` (`?id=` apre il pannello).
 */
function VotazioniInner() {
  const t = useTranslations('votazioniAdmin');
  return (
    <CockpitPage>
      <PageHeader icon={Vote} title={t('titoloPagina')} subtitle={t('sottotitolo')} />
      <SedeRequired cosa={t('sedeCosa')}>{(scuolaId) => <VotazioniShell key={scuolaId} scuolaId={scuolaId} />}</SedeRequired>
    </CockpitPage>
  );
}

export default function AdminVotazioniPage() {
  return (
    <Suspense fallback={null}>
      <VotazioniInner />
    </Suspense>
  );
}
