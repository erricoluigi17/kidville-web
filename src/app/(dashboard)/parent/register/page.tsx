'use client';

import { useState } from 'react';
import { BookOpen, Award, AlertTriangle, CheckCircle, FileText } from 'lucide-react';

export default function ParentRegisterPage() {
    const [signed, setSigned] = useState(false);

    const handleSign = async () => {
        // Simulazione chiamata API a /api/notes/sign
        setSigned(true);
    };

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-6 flex flex-col gap-6">
            <div className="mb-2">
                <h1 className="font-barlow font-bold text-3xl text-kidville-green uppercase tracking-wide">
                    Diario e Valutazioni
                </h1>
                <p className="font-maven text-gray-500 mt-1">Giulia Bianchi • 3A Primaria</p>
            </div>

            {/* Note Disciplinari - Sezione Prioritaria se ci sono note da firmare */}
            <div className={`bg-white border-2 rounded-card p-5 ${signed ? 'border-gray-100' : 'border-kidville-error shadow-sm'}`}>
                <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${signed ? 'bg-gray-100 text-gray-400' : 'bg-red-100 text-kidville-error'}`}>
                        {signed ? <CheckCircle size={24} /> : <AlertTriangle size={24} />}
                    </div>
                    <div className="flex-1">
                        <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-1">Nota Disciplinare</h2>
                        <p className="font-maven text-gray-700 text-sm mb-3">
                            "Giulia ha disturbato ripetutamente la lezione di matematica lanciando palline di carta."
                        </p>
                        <div className="text-xs font-maven text-gray-500 mb-4">Inserita da: Maestra Sara - 02/05/2026</div>
                        
                        {!signed ? (
                            <button 
                                onClick={handleSign}
                                className="h-12 px-6 font-barlow font-bold text-lg rounded-pill bg-kidville-yellow text-kidville-green hover:opacity-90 w-full sm:w-auto transition-opacity"
                            >
                                Firma per Presa Visione
                            </button>
                        ) : (
                            <div className="inline-flex items-center gap-2 bg-kidville-success/10 text-kidville-success px-4 py-2 rounded-pill font-maven font-semibold text-sm">
                                <CheckCircle size={16} /> Firmata il {new Date().toLocaleDateString('it-IT')}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Diario Lezioni e Compiti */}
                <div className="bg-kidville-white rounded-card shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <BookOpen className="text-kidville-green" />
                        <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase">Diario di Oggi</h2>
                    </div>
                    
                    <div className="border-l-2 border-kidville-cream ml-3 pl-4 flex flex-col gap-5">
                        <div className="relative">
                            <div className="absolute -left-[23px] top-1 w-3 h-3 rounded-full bg-kidville-yellow"></div>
                            <h3 className="font-maven font-semibold text-kidville-green">Italiano</h3>
                            <p className="font-maven text-sm text-gray-600 mt-1">Spiegazione de "I Promessi Sposi".</p>
                            <div className="mt-2 bg-yellow-50 p-3 rounded-xl border border-yellow-100">
                                <strong className="font-maven text-sm text-kidville-green block mb-1">Compiti per domani:</strong>
                                <span className="font-maven text-sm text-gray-700">Studiare da pagina 12 a pagina 15 e fare il riassunto.</span>
                            </div>
                        </div>

                        <div className="relative">
                            <div className="absolute -left-[23px] top-1 w-3 h-3 rounded-full bg-kidville-green"></div>
                            <h3 className="font-maven font-semibold text-kidville-green">Matematica</h3>
                            <p className="font-maven text-sm text-gray-600 mt-1">Le frazioni equivalenti.</p>
                            <button className="mt-2 text-sm font-maven text-kidville-green underline flex items-center gap-1">
                                <FileText size={14} /> Vedi foto lavagna
                            </button>
                        </div>
                    </div>
                </div>

                {/* Valutazioni Recenti */}
                <div className="bg-kidville-white rounded-card shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <Award className="text-kidville-green" />
                        <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase">Voti Recenti</h2>
                    </div>

                    <div className="flex flex-col gap-3">
                        <div className="flex justify-between items-center p-3 hover:bg-gray-50 rounded-xl border border-gray-50">
                            <div>
                                <div className="font-maven font-semibold text-kidville-green">Italiano - Tema</div>
                                <div className="text-xs text-gray-400 font-maven">Oggi, 10:30</div>
                            </div>
                            <div className="w-10 h-10 rounded-xl bg-kidville-green text-white flex items-center justify-center font-maven font-bold text-lg">
                                8
                            </div>
                        </div>
                        
                        <div className="flex justify-between items-center p-3 hover:bg-gray-50 rounded-xl border border-gray-50">
                            <div>
                                <div className="font-maven font-semibold text-kidville-green">Storia - Interrogazione</div>
                                <div className="text-xs text-gray-400 font-maven">Ieri, 11:00</div>
                            </div>
                            <div className="px-3 h-10 rounded-xl bg-kidville-yellow text-kidville-green flex items-center justify-center font-maven font-bold text-sm">
                                Avanzato
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
