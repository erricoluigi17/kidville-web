'use client';

import { useTranslations } from 'next-intl';
import { FileSignature } from 'lucide-react';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { SedeNotice } from '@/lib/context/sede-context';
import { DocumentiFirmatiPanel } from '@/components/features/documenti/DocumentiFirmatiPanel';

/**
 * Segreteria — l'archivio dei documenti firmati, per sede, classe e alunno.
 *
 * Il filtro di sede NON è in questa pagina: è quello globale del cockpit
 * (`SedeNotice` + cookie `sedi_attive`), che la route legge da sé con
 * `resolveScuoleAttive`. Due filtri di sede, uno di pagina e uno di contesto,
 * sono un modo per litigare fra loro e mostrare la sede sbagliata.
 */
export default function AdminDocumentiFirmatiPage() {
  const t = useTranslations('documenti');

  return (
    <CockpitPage>
      <PageHeader icon={FileSignature} title={t('titolo')} subtitle={t('sottotitolo')} />
      <SedeNotice cosa={t('titolo').toLowerCase()} />
      <DocumentiFirmatiPanel conFiltroSede />
    </CockpitPage>
  );
}
