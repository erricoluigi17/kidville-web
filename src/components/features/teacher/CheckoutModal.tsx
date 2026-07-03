'use client';

import { useState } from 'react';
import { LocalDelegate } from '@/lib/offline/db';
import { X, AlertTriangle, User } from 'lucide-react';

interface Props {
    studentName: string;
    delegates: LocalDelegate[];
    onClose: () => void;
    onConfirmCheckout: (delegateId?: string) => void;
    onPanicAlert: () => void;
}

export function CheckoutModal({ studentName, delegates, onClose, onConfirmCheckout, onPanicAlert }: Props) {
    const [isPanicLoading, setIsPanicLoading] = useState(false);

    const handlePanic = async () => {
        setIsPanicLoading(true);
        await onPanicAlert();
        setIsPanicLoading(false);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kidville-green/30 p-4">
            <div className="bg-kidville-white w-full max-w-md rounded-card shadow-lg flex flex-col max-h-[90vh]">
                
                <div className="p-4 border-b border-kidville-line flex items-center justify-between">
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase">
                        Uscita: {studentName}
                    </h2>
                    <button onClick={onClose} className="p-2 text-kidville-muted hover:text-kidville-error transition-colors">
                        <X size={24} />
                    </button>
                </div>

                <div className="p-4 overflow-y-auto flex-1">
                    <h3 className="font-maven font-medium text-sm text-kidville-muted mb-3 uppercase tracking-wider">
                        Delegati Autorizzati
                    </h3>
                    
                    {delegates.length === 0 ? (
                        <p className="text-sm text-kidville-muted italic text-center py-4">Nessun delegato registrato.</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {delegates.map(delegate => (
                                <div key={delegate.id} className="border border-kidville-line rounded-lg p-3 flex items-center gap-3">
                                    <div className="w-12 h-12 bg-kidville-cream rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center text-kidville-green">
                                        {delegate.foto_url ? (
                                            <img src={delegate.foto_url} alt={delegate.nome} className="w-full h-full object-cover" />
                                        ) : (
                                            <User size={24} />
                                        )}
                                    </div>
                                    <div className="flex-1">
                                        <div className="font-barlow font-semibold text-kidville-green text-lg">{delegate.nome}</div>
                                        <div className="text-xs font-maven text-kidville-muted uppercase">{delegate.relazione}</div>
                                    </div>
                                    <button 
                                        onClick={() => onConfirmCheckout(delegate.id)}
                                        className="h-8 px-3 text-sm font-maven rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90"
                                    >
                                        Conferma
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="p-4 bg-kidville-cream border-t border-kidville-line rounded-b-card">
                    <button 
                        onClick={handlePanic}
                        disabled={isPanicLoading}
                        className="w-full h-12 font-barlow font-bold text-lg rounded-pill bg-kidville-error text-white flex items-center justify-center gap-2 hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                        <AlertTriangle size={20} />
                        {isPanicLoading ? 'Invio Allarme...' : 'PANIC ALERT - Ritiro Non Autorizzato'}
                    </button>
                    <p className="text-xs font-maven text-center text-kidville-muted mt-2">
                        Blocca l&apos;uscita e invia una notifica immediata alla Segreteria e al Genitore.
                    </p>
                </div>
            </div>
        </div>
    );
}
