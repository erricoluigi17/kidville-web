'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, FileText, Tag, AlertTriangle, Calendar, Save, CheckSquare } from 'lucide-react';
import { Task } from './TaskCard';

interface StaffMember {
    id: string;
    first_name: string;
    last_name: string;
    role: string;
}

interface TaskEditModalProps {
    task: Task;
    open: boolean;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<{
        titolo: string;
        contenuto: string;
        priority: string;
        category: string;
        deadline: string | null;
        status: string;
        assigned_to: string | string[];
        resolution_notes: string;
        resolved_by: string;
    }>) => Promise<void>;
    staffMembers: StaffMember[];
    currentUserId: string;
}

export function TaskEditModal({ task, open, onClose, onSave, currentUserId }: TaskEditModalProps) {
    // Il form si inizializza dal task al mount: il parent monta la modale
    // solo quando c'è un task in modifica, quindi equivale alla vecchia
    // useEffect di init (rimossa per la regola set-state-in-effect).
    const [titolo, setTitolo] = useState(task.titolo || '');
    const [contenuto, setContenuto] = useState(task.descrizione || task.contenuto || '');
    const [priority, setPriority] = useState<string>(task.priority || 'medium');
    const [category, setCategory] = useState(task.category || 'generale');
    const [deadline, setDeadline] = useState(() => task.deadline ? new Date(task.deadline).toISOString().split('T')[0] : '');
    const [deadlineTime, setDeadlineTime] = useState(() => task.deadline ? new Date(task.deadline).toTimeString().slice(0, 5) : '');
    const [status, setStatus] = useState<string>(task.status || 'todo');
    const [resolutionNotes, setResolutionNotes] = useState(task.resolution_notes || '');
    const [isSaving, setIsSaving] = useState(false);

    if (!open) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            let deadlineISO: string | null = null;
            if (deadline) {
                const time = deadlineTime || '23:59';
                deadlineISO = new Date(`${deadline}T${time}`).toISOString();
            }

            const updates: Parameters<typeof onSave>[1] = {
                titolo,
                contenuto,
                priority,
                category,
                deadline: deadlineISO,
                status,
            };

            if (status === 'completed' && resolutionNotes) {
                updates.resolution_notes = resolutionNotes;
                updates.resolved_by = currentUserId;
            }

            await onSave(task.id, updates);
            onClose();
        } catch (err) {
            console.error('Errore modifica task:', err);
            alert('Errore durante il salvataggio');
        } finally {
            setIsSaving(false);
        }
    };

    const statusOptions = [
        { value: 'todo', label: 'Da Fare', color: 'text-kidville-ink' },
        { value: 'in_progress', label: 'In Corso', color: 'text-kidville-warn' },
        { value: 'completed', label: 'Completato', color: 'text-kidville-success' },
    ];

    return (
        <>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50"
                onClick={onClose}
            />
            <motion.div
                initial={{ opacity: 0, y: 40, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 30, scale: 0.96 }}
                className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden border border-white/20"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-kidville-line bg-kidville-cream/30">
                    <div className="flex items-center gap-2">
                        <FileText className="text-kidville-green" size={18} />
                        <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">
                            Modifica Task
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-xl bg-kidville-cream hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted"
                    >
                        <X size={14} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
                    {/* Status */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-2 flex items-center gap-1">
                            <CheckSquare size={12} /> Stato del Task
                        </label>
                        <div className="flex gap-2">
                            {statusOptions.map(opt => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setStatus(opt.value)}
                                    className={`flex-1 py-2.5 rounded-2xl text-xs font-bold font-barlow uppercase tracking-wider border-2 transition-all
                                        ${status === opt.value
                                            ? opt.value === 'todo' ? 'border-kidville-line bg-kidville-cream text-kidville-ink'
                                            : opt.value === 'in_progress' ? 'border-kidville-warn bg-kidville-warn-soft text-kidville-warn'
                                            : 'border-kidville-success bg-kidville-success-soft text-kidville-success'
                                        : 'border-kidville-line text-kidville-muted hover:border-kidville-line'}`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Titolo */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
                            Titolo
                        </label>
                        <input
                            type="text"
                            required
                            value={titolo}
                            onChange={e => setTitolo(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                        />
                    </div>

                    {/* Contenuto */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
                            Istruzioni / Descrizione
                        </label>
                        <textarea
                            rows={3}
                            value={contenuto}
                            onChange={e => setContenuto(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                        />
                    </div>

                    {/* Categoria e Priorità */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                                <Tag size={11} /> Categoria
                            </label>
                            <select
                                value={category}
                                onChange={e => setCategory(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            >
                                <option value="generale">Generale</option>
                                <option value="genitore">Messaggio Genitore</option>
                                <option value="amministrativo">Amministrativo</option>
                                <option value="servizio">Nota di Servizio</option>
                                <option value="manutenzione">Manutenzione</option>
                                <option value="didattico">Didattico</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                                <AlertTriangle size={11} /> Priorità
                            </label>
                            <select
                                value={priority}
                                onChange={e => setPriority(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            >
                                <option value="low">Bassa</option>
                                <option value="medium">Media</option>
                                <option value="high">Alta</option>
                                <option value="urgent">🚨 Urgente</option>
                            </select>
                        </div>
                    </div>

                    {/* Scadenza */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                            <Calendar size={11} /> Scadenza
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <input
                                type="date"
                                value={deadline}
                                onChange={e => setDeadline(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            />
                            <input
                                type="time"
                                value={deadlineTime}
                                onChange={e => setDeadlineTime(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            />
                        </div>
                    </div>

                    {/* Resolution notes when marking completed */}
                    {status === 'completed' && (
                        <div className="p-4 bg-kidville-success-soft/30 rounded-2xl border border-kidville-success/30">
                            <label className="block text-xs font-bold text-kidville-success uppercase tracking-wider mb-2">
                                ✅ Note di Verifica / Completamento
                            </label>
                            <textarea
                                rows={3}
                                placeholder="Indica come è stato risolto il task o le note di verifica..."
                                value={resolutionNotes}
                                onChange={e => setResolutionNotes(e.target.value)}
                                className="w-full border border-kidville-success/30 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-success transition-all"
                            />
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 pt-2 border-t border-kidville-line">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 py-3 border-2 border-kidville-line hover:bg-kidville-cream rounded-2xl font-barlow font-black uppercase text-sm text-kidville-muted tracking-wider transition-all"
                        >
                            Annulla
                        </button>
                        <button
                            type="submit"
                            disabled={isSaving}
                            className="flex-1 py-3 bg-kidville-green text-kidville-yellow hover:opacity-90 rounded-2xl font-barlow font-black uppercase text-sm tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20"
                        >
                            <Save size={14} />
                            {isSaving ? 'Salvataggio...' : 'Salva Modifiche'}
                        </button>
                    </div>
                </form>
            </motion.div>
        </>
    );
}
