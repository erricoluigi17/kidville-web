'use client';

import { Users } from 'lucide-react';
import { FamilyRegistryManager } from '@/components/features/admin/FamilyRegistryManager';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';

export default function NewRegistryPage() {
    return (
        <CockpitPage max={1152}>
            <PageHeader icon={Users} title="Gestione Anagrafica Famiglia" subtitle="Inserimento nuova famiglia: alunni, genitori e delegati." />
            <FamilyRegistryManager />
        </CockpitPage>
    );
}
