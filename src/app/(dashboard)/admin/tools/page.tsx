'use client';

import { useTranslations } from 'next-intl';
import { Wrench } from 'lucide-react';
import { ImportExportClient } from '@/components/features/admin/ImportExportClient';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

export default function AdminToolsPage() {
    const t = useTranslations('adminNav');
    return (
        <CockpitPage max={1152}>
            <PageHeader eyebrow={t('toolsEyebrow')} icon={Wrench} title={t('toolsTitolo')} subtitle={t('toolsSottotitolo')} />
            <ImportExportClient />
        </CockpitPage>
    );
}
