'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Handshake } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { SedeRequired } from '@/lib/context/sede-context';
import { CrmShell } from '@/components/features/crm/CrmShell';

/**
 * Il CRM della segreteria (`/admin/crm`): le famiglie che chiedono informazioni, le visite in agenda
 * e i richiami da fare. Specifica: `docs/superpowers/specs/2026-10-30-crm-segreteria-design.md`.
 *
 * La sede è OBBLIGATORIA e UNA sola: `SedeRequired` rende la cornice solo quando c'è una sede
 * risolta — la propria per la segreteria, quella scelta per l'admin con più plessi, che altrimenti
 * vede l'invito a sceglierne una. Fino ad allora non parte nessuna richiesta: con tre sedi in
 * produzione una schermata che «sceglie da sola» mostrerebbe famiglie del plesso sbagliato, in
 * silenzio (AGENTS.md, Note).
 *
 * Il `Suspense` serve a `CrmShell` e alle schermate che monta, che leggono `useSearchParams`
 * (`?tab=` e i filtri di `useFiltri`).
 */
function CrmInner() {
  const t = useTranslations('crmShell');
  return (
    <CockpitPage>
      <PageHeader icon={Handshake} eyebrow={t('eyebrow')} title={t('titolo')} subtitle={t('sottotitolo')} />
      <SedeRequired cosa={t('sedeCosa')}>{(scuolaId) => <CrmShell scuolaId={scuolaId} />}</SedeRequired>
    </CockpitPage>
  );
}

export default function AdminCrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmInner />
    </Suspense>
  );
}
