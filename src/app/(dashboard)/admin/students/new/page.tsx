'use client';

import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { FamilyRegistryManager } from '@/components/features/admin/FamilyRegistryManager';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

export default function NewRegistryPage() {
    const t = useTranslations('adminStudents');
    return (
        <CockpitPage max={1152}>
            <PageHeader icon={Users} eyebrow={t('listEyebrow')} title={t('newTitolo')} subtitle={t('newSottotitolo')} />
            <FamilyRegistryManager />
        </CockpitPage>
    );
}
