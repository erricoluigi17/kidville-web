'use client';

import React, { useState } from 'react';
import { Upload, Download, Loader2, CheckCircle, FileSpreadsheet, FileDown, AlertTriangle } from 'lucide-react';
import { createBrowserClient } from '@supabase/ssr';
import { buildTemplateCsv } from '@/lib/import/template';

interface ImportOutcome {
    totale: number;
    alunniCreati: number;
    genitoriCreati: number;
    legami: number;
    errori: { riga: number; messaggio: string }[];
}

export function ImportExportClient() {
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
    const [importError, setImportError] = useState<string | null>(null);

    const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const { data, error } = await supabase.from('alunni').select('*');
            if (error) throw error;

            // xlsx caricato on-demand solo quando serve.
            const XLSX = await import('xlsx');
            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Alunni');
            XLSX.writeFile(workbook, `Esportazione_Alunni_${new Date().toISOString().split('T')[0]}.xlsx`);
        } catch (error) {
            console.error('Errore esportazione:', error);
            alert("Errore durante l'esportazione.");
        } finally {
            setIsExporting(false);
        }
    };

    // Scarica il prestampato CSV (alunno + genitori) da compilare.
    const handleDownloadTemplate = () => {
        const blob = new Blob([buildTemplateCsv()], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'prestampato_anagrafiche_kidville.csv';
        a.click();
        URL.revokeObjectURL(url);
    };

    // Importa il file compilato: parse lato client → POST al server che crea
    // alunni + genitori collegati (dedup su CF), con scoping/gate applicativo.
    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsImporting(true);
        setOutcome(null);
        setImportError(null);

        try {
            const XLSX = await import('xlsx');
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' });

            if (rows.length === 0) throw new Error('Il file è vuoto');

            const res = await fetch('/api/admin/import/anagrafiche', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Errore durante l’import');

            setOutcome(body as ImportOutcome);
        } catch (error) {
            console.error('Errore importazione:', error);
            setImportError((error as Error).message);
        } finally {
            setIsImporting(false);
            if (e.target) e.target.value = '';
        }
    };

    return (
        <div className="p-8 bg-white backdrop-blur-xl border border-kidville-green/15 rounded-3xl text-kidville-green">
            <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
                <FileSpreadsheet className="text-kidville-green" /> Import / Export Anagrafiche
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Export Card */}
                <div className="bg-kidville-cream border border-kidville-green/15 p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-4">
                    <div className="p-4 bg-kidville-green/20 rounded-full text-kidville-green">
                        <Download size={32} />
                    </div>
                    <div>
                        <h3 className="font-bold text-lg">Esporta Anagrafiche</h3>
                        <p className="text-sm text-kidville-muted mt-1">Scarica gli alunni in Excel (backup / report).</p>
                    </div>
                    <button
                        onClick={handleExport}
                        disabled={isExporting}
                        className="mt-4 px-6 py-2 bg-white border border-kidville-green/20 hover:bg-kidville-green-light rounded-full font-medium transition-all flex items-center gap-2"
                    >
                        {isExporting ? <Loader2 size={18} className="animate-spin" /> : 'Genera Esportazione'}
                    </button>
                </div>

                {/* Import anagrafiche complete (alunno + genitori) */}
                <div className="bg-kidville-cream border border-kidville-green/15 p-6 rounded-2xl flex flex-col items-center justify-center text-center gap-4">
                    <div className="p-4 bg-kidville-info-soft0/20 rounded-full text-kidville-info">
                        <Upload size={32} />
                    </div>
                    <div>
                        <h3 className="font-bold text-lg">Importa Anagrafiche</h3>
                        <p className="text-sm text-kidville-muted mt-1">Scarica il prestampato, compilalo (alunno + genitori) e ricaricalo.</p>
                    </div>

                    <div className="flex flex-col gap-2 w-full items-center">
                        <button
                            onClick={handleDownloadTemplate}
                            className="px-5 py-2 bg-white border border-kidville-green/20 text-kidville-green rounded-full font-medium transition-all cursor-pointer flex items-center gap-2 hover:bg-kidville-green-light"
                        >
                            <FileDown size={18} /> Scarica prestampato CSV
                        </button>

                        <label className={`px-6 py-2 bg-kidville-info hover:bg-kidville-info-soft0 text-white rounded-full font-medium transition-all cursor-pointer flex items-center gap-2 ${isImporting ? 'opacity-50 pointer-events-none' : ''}`}>
                            {isImporting ? <Loader2 size={18} className="animate-spin" /> : 'Carica file compilato'}
                            <input type="file" accept=".xlsx, .xls, .csv" onChange={handleImport} className="hidden" />
                        </label>
                    </div>

                    {outcome && (
                        <div className="mt-2 w-full p-3 bg-kidville-success/20 border border-kidville-success/30 rounded-xl text-kidville-success text-sm font-bold flex flex-col gap-1">
                            <span className="flex items-center gap-2"><CheckCircle size={16} /> {outcome.alunniCreati} alunni, {outcome.genitoriCreati} genitori, {outcome.legami} collegamenti</span>
                            {outcome.errori.length > 0 && (
                                <span className="flex items-center gap-2 text-kidville-warn font-medium">
                                    <AlertTriangle size={14} /> {outcome.errori.length} righe con errori (righe: {outcome.errori.map(e => e.riga).join(', ')})
                                </span>
                            )}
                        </div>
                    )}
                    {importError && (
                        <div className="mt-2 w-full p-3 bg-kidville-error/10 border border-kidville-error/30 rounded-xl text-kidville-error text-sm font-bold flex items-center gap-2">
                            <AlertTriangle size={16} /> {importError}
                        </div>
                    )}
                </div>
            </div>

            <div className="mt-6 text-xs text-kidville-muted bg-kidville-cream p-4 rounded-xl border border-kidville-green/10">
                <strong>Come funziona:</strong> il prestampato ha una colonna per ogni dato dell&apos;alunno e fino a due genitori. All&apos;import il sistema crea gli alunni e i genitori collegati, evitando i duplicati tramite il codice fiscale. La sede è quella attiva.
            </div>
        </div>
    );
}
