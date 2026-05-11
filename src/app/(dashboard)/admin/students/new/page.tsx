import { FamilyRegistryManager } from '@/components/features/admin/FamilyRegistryManager';

export default function NewRegistryPage() {
    return (
        <div className="p-6 max-w-6xl mx-auto space-y-12">
            <div>
                <h1 className="text-3xl font-black text-kidville-green mb-8 text-center font-barlow uppercase">Gestione Anagrafica Famiglia</h1>
                <FamilyRegistryManager />
            </div>
        </div>
    );
}
