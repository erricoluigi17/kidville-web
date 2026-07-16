'use client';

import { Wrench } from 'lucide-react';
import { ImportExportClient } from '@/components/features/admin/ImportExportClient';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

export default function AdminToolsPage() {
    return (
        <CockpitPage max={1152}>
            <PageHeader eyebrow="Sistema" icon={Wrench} title="Strumenti Amministratore" subtitle="Import/export dati e utilità di manutenzione." />
            <ImportExportClient />
        </CockpitPage>
    );
}
