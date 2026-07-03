'use client';

import React, { useState } from 'react';
import { Upload, Download, Loader2, CheckCircle, FileSpreadsheet } from 'lucide-react';
import { createBrowserClient } from '@supabase/ssr';

export function ImportExportClient() {
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importResult, setImportResult] = useState<{ total: number, success: number } | null>(null);

    const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const { data, error } = await supabase.from('alunni').select('*');
            if (error) throw error;

            // M9.4: xlsx caricato on-demand solo quando si esporta/importa.
            const XLSX = await import('xlsx');
            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Alunni");
            
            XLSX.writeFile(workbook, `Esportazione_Alunni_${new Date().toISOString().split('T')[0]}.xlsx`);
        } catch (error) {
            console.error("Errore esportazione:", error);
            alert("Errore durante l'esportazione.");
        } finally {
            setIsExporting(false);
        }
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsImporting(true);
        setImportResult(null);

        try {
            const XLSX = await import('xlsx');
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);

            if (jsonData.length === 0) throw new Error("Il file è vuoto");

            // Eseguiamo un upsert massivo tramite il client browser per evitare timeout Vercel
            const { error, data: resultData } = await supabase
                .from('alunni')
                .upsert(jsonData, { onConflict: 'id' })
                .select();

            if (error) throw error;

            setImportResult({ total: jsonData.length, success: resultData?.length || jsonData.length });
        } catch (error) {
            console.error("Errore importazione:", error);
            alert(`Errore importazione: ${(error as Error).message}`);
        } finally {
            setIsImporting(false);
            if (e.target) e.target.value = ''; // Reset input
        }
    };

    return (
        <div className="p-8 bg-white backdrop-blur-xl border border-kidville-green/15 rounded-3xl text-kidville-green">
            <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <FileSpreadsheet className="text-kidville-green" /> Import/Export Dati Client-Side
            </h2>

            <div className="grid grid-cols-2 gap-8">
                {/* Export Card */}
                <div className="bg-kidville-cream border border-kidville-green/15 p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-4">
                    <div className="p-4 bg-kidville-green/20 rounded-full text-kidville-green">
                        <Download size={32} />
                    </div>
                    <div>
                        <h3 className="font-bold text-lg">Esporta Anagrafiche</h3>
                        <p className="text-sm text-kidville-muted mt-1">Scarica i dati completi in formato Excel.</p>
                    </div>
                    <button 
                        onClick={handleExport}
                        disabled={isExporting}
                        className="mt-4 px-6 py-2 bg-kidville-cream hover:bg-kidville-green-light rounded-full font-medium transition-all flex items-center gap-2"
                    >
                        {isExporting ? <Loader2 size={18} className="animate-spin" /> : "Genera Esportazione"}
                    </button>
                </div>

                {/* Import Card */}
                <div className="bg-kidville-cream border border-kidville-green/15 p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-4">
                    <div className="p-4 bg-kidville-info-soft0/20 rounded-full text-kidville-info">
                        <Upload size={32} />
                    </div>
                    <div>
                        <h3 className="font-bold text-lg">Importa e Sincronizza</h3>
                        <p className="text-sm text-kidville-muted mt-1">Carica un file Excel per aggiornare o inserire record.</p>
                    </div>
                    
                    <label className={`mt-4 px-6 py-2 bg-kidville-info hover:bg-kidville-info-soft0 rounded-full font-medium transition-all cursor-pointer flex items-center gap-2 ${isImporting ? 'opacity-50 pointer-events-none' : ''}`}>
                        {isImporting ? <Loader2 size={18} className="animate-spin" /> : "Scegli File .xlsx"}
                        <input type="file" accept=".xlsx, .xls, .csv" onChange={handleImport} className="hidden" />
                    </label>

                    {importResult && (
                        <div className="mt-4 p-3 bg-kidville-success/20 border border-kidville-success/30 rounded-xl flex items-center gap-2 text-kidville-success text-sm font-bold">
                            <CheckCircle size={16} /> Importati {importResult.success} su {importResult.total} record!
                        </div>
                    )}
                </div>
            </div>
            
            <div className="mt-6 text-xs text-kidville-muted bg-kidville-cream p-4 rounded-xl border border-kidville-green/10">
                <strong>Nota Tecnica:</strong> Questa operazione viene eseguita interamente lato browser utilizzando <code>xlsx</code> e il client Supabase. Questo approccio aggira i limiti di timeout di esecuzione dei serverless function di Next.js su Vercel, ideali per elaborazioni massive di dati.
            </div>
        </div>
    );
}
