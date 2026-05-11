import { ImportExportClient } from '@/components/features/admin/ImportExportClient';

export default function AdminToolsPage() {
    return (
        <div className="p-6 max-w-6xl mx-auto space-y-8">
            <h1 className="text-3xl font-black text-kidville-green mb-8 text-center font-barlow uppercase">Strumenti Amministratore</h1>
            <ImportExportClient />
        </div>
    );
}
