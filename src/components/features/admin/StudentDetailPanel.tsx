'use client';

import { useState, useEffect } from 'react';
import { X, Trash2, Save, AlertTriangle } from 'lucide-react';

interface Student {
    id: string;
    nome: string;
    cognome: string;
    data_nascita: string;
    classe_sezione: string | null;
    stato: string;
    note_mediche: string | null;
    codice_fiscale: string | null;
    bes?: boolean;
    note_bes?: string | null;
}

interface Props {
    student: Student | null;
    onClose: () => void;
    onSave: (data: Partial<Student> & { id: string }) => void;
    onDelete: (id: string) => void;
}

export function StudentDetailPanel({ student, onClose, onSave, onDelete }: Props) {
    const [form, setForm] = useState<Partial<Student>>({});
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (student) {
            setForm({ ...student });
            setShowDeleteConfirm(false);
        }
    }, [student]);

    if (!student) return null;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await onSave({ id: student.id, ...form });
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = () => {
        if (showDeleteConfirm) {
            onDelete(student.id);
            setShowDeleteConfirm(false);
        } else {
            setShowDeleteConfirm(true);
        }
    };

    const updateForm = (field: string, value: unknown) => {
        setForm(prev => ({ ...prev, [field]: value }));
    };

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />

            {/* Panel slide-in */}
            <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-2xl flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-gray-100">
                    <div>
                        <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
                            Scheda Alunno
                        </h2>
                        <p className="font-maven text-sm text-gray-500">
                            {student.nome} {student.cognome}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Scrollable Form */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Dati Anagrafici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            Dati Anagrafici
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-gray-500 mb-1 block">Nome</label>
                                <input
                                    type="text"
                                    value={(form.nome as string) ?? ''}
                                    onChange={e => updateForm('nome', e.target.value)}
                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-gray-500 mb-1 block">Cognome</label>
                                <input
                                    type="text"
                                    value={(form.cognome as string) ?? ''}
                                    onChange={e => updateForm('cognome', e.target.value)}
                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-3">
                            <div>
                                <label className="font-maven text-xs text-gray-500 mb-1 block">Data di Nascita</label>
                                <input
                                    type="date"
                                    value={(form.data_nascita as string) ?? ''}
                                    onChange={e => updateForm('data_nascita', e.target.value)}
                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-gray-500 mb-1 block">Codice Fiscale</label>
                                <input
                                    type="text"
                                    value={(form.codice_fiscale as string) ?? ''}
                                    onChange={e => updateForm('codice_fiscale', e.target.value.toUpperCase())}
                                    maxLength={16}
                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green uppercase"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Classe e Stato */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            Classe e Stato
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-gray-500 mb-1 block">Classe / Sezione</label>
                                <input
                                    type="text"
                                    value={(form.classe_sezione as string) ?? ''}
                                    onChange={e => updateForm('classe_sezione', e.target.value)}
                                    placeholder="es. Girasoli"
                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-gray-500 mb-1 block">Stato</label>
                                <select
                                    value={(form.stato as string) ?? 'iscritto'}
                                    onChange={e => updateForm('stato', e.target.value)}
                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="iscritto">Iscritto</option>
                                    <option value="ritirato">Ritirato</option>
                                    <option value="sospeso">Sospeso</option>
                                </select>
                            </div>
                        </div>
                    </section>

                    {/* Dati Medici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <AlertTriangle size={12} className="text-kidville-error" />
                            Dati Medici / Didattici
                        </h3>

                        <div className="mb-3">
                            <label className="font-maven text-xs text-gray-500 mb-1 block">Allergie / Intolleranze</label>
                            <textarea
                                value={(form.note_mediche as string) ?? ''}
                                onChange={e => updateForm('note_mediche', e.target.value)}
                                placeholder="Es: Lattosio, Frutta secca"
                                rows={2}
                                className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                            {form.note_mediche && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {(form.note_mediche as string).split(',').map((a, i) => (
                                        <span key={i} className="bg-red-50 text-red-700 text-xs font-maven font-bold px-2 py-0.5 rounded-full border border-red-200">
                                            {a.trim()}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="flex items-center gap-3 mb-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.bes}
                                    onChange={e => updateForm('bes', e.target.checked)}
                                    className="w-4 h-4 rounded border-gray-300 text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">BES (Bisogni Educativi Speciali)</span>
                            </label>
                        </div>

                        {form.bes && (
                            <textarea
                                value={(form.note_bes as string) ?? ''}
                                onChange={e => updateForm('note_bes', e.target.value)}
                                placeholder="Note BES..."
                                rows={2}
                                className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                        )}
                    </section>
                </div>

                {/* Footer actions */}
                <div className="flex-shrink-0 p-5 border-t border-gray-100 space-y-3">
                    {/* Salva */}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="w-full h-12 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isSaving ? (
                            <div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                        ) : (
                            <>
                                <Save size={16} />
                                Salva Modifiche
                            </>
                        )}
                    </button>

                    {/* Hard Delete GDPR */}
                    <button
                        onClick={handleDelete}
                        className={`w-full h-10 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm transition-all flex items-center justify-center gap-2 ${
                            showDeleteConfirm
                                ? 'bg-red-600 text-white hover:bg-red-700'
                                : 'bg-red-50 text-red-600 border-2 border-red-200 hover:bg-red-100'
                        }`}
                    >
                        <Trash2 size={14} />
                        {showDeleteConfirm
                            ? '⚠️ Conferma eliminazione definitiva (GDPR)'
                            : 'Elimina Alunno (GDPR)'
                        }
                    </button>

                    {showDeleteConfirm && (
                        <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                            <p className="font-maven text-xs text-red-700">
                                <strong>Attenzione:</strong> Questa azione è <strong>irreversibile</strong> e cancellerà tutti i dati dell&apos;alunno dal sistema (diario, presenze, armadietto). Un record audit verrà conservato.
                            </p>
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="mt-2 text-xs font-maven font-bold text-gray-500 hover:text-gray-700"
                            >
                                Annulla
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
