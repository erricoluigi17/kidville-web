'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { Avviso } from './AvvisoCard';
import { AvvisoDetailsContent } from './AvvisoDetailsContent';

// Slide-over mobile del docente: header + guscio animato; il monitoraggio
// (stati lettura/adesioni, filtri, elenchi) vive in AvvisoDetailsContent,
// condiviso con la pagina cockpit /admin/avvisi/[id].

interface Props {
    open: boolean;
    avviso: Avviso | null;
    onClose: () => void;
    availableClasses?: string[];
}

export function AvvisoDetailsDrawer({ open, avviso, onClose, availableClasses = [] }: Props) {
    if (!avviso) return null;

    const isAdesione = avviso.tipo === 'adesione';

    return (
        <AnimatePresence>
            {open && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50"
                    />

                    {/* Drawer */}
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                        className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white/95 backdrop-blur-xl shadow-2xl z-50 flex flex-col h-full border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="px-6 py-5 border-b border-gray-100 flex items-start justify-between bg-white">
                            <div>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-barlow font-bold uppercase tracking-wider bg-kidville-info-soft text-kidville-info">
                                    {isAdesione ? 'Adesione Interattiva' : 'Presa Visione'}
                                </span>
                                <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mt-1.5 line-clamp-1">
                                    {avviso.titolo}
                                </h2>
                                <p className="font-maven text-xs text-gray-400 mt-0.5">
                                    Target: {avviso.target_scope === 'globale' ? 'Tutto l\'Istituto' : `Classi (${avviso.target_classes?.join(', ') || ''})`}
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                className="w-8 h-8 rounded-xl bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                            >
                                <X size={16} strokeWidth={1.5} />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6">
                            <AvvisoDetailsContent avviso={avviso} availableClasses={availableClasses} layout="drawer" />
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
