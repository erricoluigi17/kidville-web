import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Tag, Shield, Calendar, Users, FileText, AlertTriangle } from 'lucide-react';

export interface TaskFormData {
    titolo: string;
    contenuto: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    category: string;
    target_scope: 'single' | 'class' | 'role' | 'global';
    assigned_to?: string | string[] | null;
    target_class?: string | null;
    target_role?: string | null;
    student_id?: string | null;
    deadline?: string | null;
    compiti?: Array<{ id: string; titolo: string; assigned_to: string; status: 'todo' | 'completed' }> | null;
}

interface StaffMember {
    id: string;
    first_name: string;
    last_name: string;
    role: string;
}

interface StudentOption {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione: string;
}

interface TaskFormProps {
    open: boolean;
    onClose: () => void;
    onSubmit: (data: TaskFormData) => Promise<void>;
    staffMembers: StaffMember[];
    students: StudentOption[];
    availableClasses: string[];
    currentUserRole?: string;       // 'educator' | 'coordinator' | 'admin'
    currentUserClasses?: string[];  // Classes this user teaches/coordinates
}

export function TaskForm({
    open,
    onClose,
    onSubmit,
    staffMembers,
    students,
    availableClasses,
    currentUserRole = 'educator',
    currentUserClasses = []
}: TaskFormProps) {
    const isAdmin = currentUserRole === 'admin';
    const isCoordinator = currentUserRole === 'coordinator';
    const isEducator = currentUserRole === 'educator';

    // Allowed scope options based on role
    const allowedScopes = isAdmin
        ? ['single', 'class', 'role', 'global']
        : isCoordinator
        ? ['single', 'class', 'role']
        : ['single', 'class']; // educators: only person or their own class

    // Classes visible in the class picker
    const visibleClasses = isAdmin
        ? availableClasses
        : isCoordinator
        ? availableClasses // coordinator sees all their school's classes
        : currentUserClasses.length > 0
        ? currentUserClasses   // educator sees only their own classes
        : availableClasses;    // fallback if no section data
    const [titolo, setTitolo] = useState('');
    const [contenuto, setContenuto] = useState('');
    const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
    const [category, setCategory] = useState('generale');
    const [targetScope, setTargetScope] = useState<'single' | 'class' | 'role' | 'global'>('single');
    const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);
    const [isSubdivided, setIsSubdivided] = useState(false);
    const [compitiList, setCompitiList] = useState<Array<{ id: string; titolo: string; assigned_to: string }>>([]);
    const [targetClass, setTargetClass] = useState('');
    const [targetRole, setTargetRole] = useState('educator');
    const [studentId, setStudentId] = useState('');
    const [deadlineDate, setDeadlineDate] = useState('');
    const [deadlineTime, setDeadlineTime] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const [prevOpen, setPrevOpen] = useState(open);
    if (open !== prevOpen) {
        setPrevOpen(open);
        if (open) {
            setTitolo('');
            setContenuto('');
            setPriority('medium');
            setCategory('generale');
            setTargetScope('single');
            setSelectedAssignees([]);
            setIsSubdivided(false);
            setCompitiList([]);
            setTargetClass('');
            setTargetRole('educator');
            setStudentId('');
            setDeadlineDate('');
            setDeadlineTime('');
        }
    }

    if (!open) return null;

    const handleFormSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!titolo.trim() || !contenuto.trim()) {
            alert('Titolo e contenuto sono richiesti!');
            return;
        }

        setIsSaving(true);
        try {
            // Combina data e ora scadenza
            let deadlineISO: string | null = null;
            if (deadlineDate) {
                const time = deadlineTime || '23:59';
                deadlineISO = new Date(`${deadlineDate}T${time}`).toISOString();
            }

            const data: TaskFormData = {
                titolo,
                contenuto,
                priority,
                category,
                target_scope: targetScope,
                student_id: studentId || null,
                deadline: deadlineISO,
            };

            // Imposta campi specifici in base allo scope
            if (targetScope === 'single') {
                if (isSubdivided) {
                    if (compitiList.length === 0) {
                        alert('Aggiungi almeno un compito!');
                        setIsSaving(false);
                        return;
                    }
                    const hasInvalid = compitiList.some(c => !c.titolo.trim() || !c.assigned_to);
                    if (hasInvalid) {
                        alert('Compila tutti i campi descrizione e destinatario dei compiti!');
                        setIsSaving(false);
                        return;
                    }
                    data.compiti = compitiList.map(c => ({
                        id: c.id,
                        titolo: c.titolo,
                        assigned_to: c.assigned_to,
                        status: 'todo'
                    }));
                    data.assigned_to = null;
                } else {
                    if (selectedAssignees.length === 0) {
                        alert('Seleziona almeno un destinatario!');
                        setIsSaving(false);
                        return;
                    }
                    data.assigned_to = selectedAssignees;
                    data.compiti = null;
                }
            } else if (targetScope === 'class') {
                data.target_class = targetClass || null;
            } else if (targetScope === 'role') {
                data.target_role = targetRole || null;
            }

            await onSubmit(data);
            onClose();
        } catch (err) {
            console.error('Errore creazione task:', err);
            alert('Errore durante la creazione del task');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <>
            {/* Overlay */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50"
                onClick={onClose}
            />

            {/* Modal */}
            <motion.div
                initial={{ opacity: 0, y: 50, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 30, scale: 0.95 }}
                className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden border border-white/20"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-kidville-line">
                    <div className="flex items-center gap-2">
                        <FileText className="text-kidville-green" size={20} />
                        <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">
                            Nuovo Task Staff
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-xl bg-kidville-cream hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted"
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleFormSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
                    {/* Titolo */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
                            Titolo del Task *
                        </label>
                        <input
                            type="text"
                            required
                            placeholder="Es. Richiesta modulo firmato per Sofia Rossi"
                            value={titolo}
                            onChange={e => setTitolo(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green focus:border-transparent transition-all"
                        />
                    </div>

                    {/* Contenuto */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
                            Descrizione / Contenuto *
                        </label>
                        <textarea
                            required
                            rows={3}
                            placeholder="Descrivi in dettaglio l'attività da svolgere..."
                            value={contenuto}
                            onChange={e => setContenuto(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green focus:border-transparent transition-all"
                        />
                    </div>

                    {/* Griglia: Categoria, Priorità */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                                <Tag size={12} /> Categoria
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
                                <option value="reclamo">Reclamo / Segnalazione</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                                <AlertTriangle size={12} /> Priorità
                            </label>
                            <select
                                value={priority}
                                onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high' | 'urgent')}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            >
                                <option value="low">Bassa</option>
                                <option value="medium">Media</option>
                                <option value="high">Alta</option>
                                <option value="urgent">🚨 Urgente</option>
                            </select>
                        </div>
                    </div>

                    {/* Scope del Destinatario */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                            <Users size={12} /> Destinatari del Task
                        </label>
                        <div className={`grid gap-1.5 bg-kidville-cream p-1 rounded-2xl border border-kidville-line`}
                            style={{ gridTemplateColumns: `repeat(${allowedScopes.length}, 1fr)` }}
                        >
                            {([
                                { key: 'single', label: 'Persona' },
                                { key: 'class', label: 'Classe' },
                                { key: 'role', label: 'Ruolo' },
                                { key: 'global', label: 'Tutti' }
                            ] as const).filter(({ key }) => allowedScopes.includes(key)).map(({ key, label }) => (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => setTargetScope(key)}
                                    className={`py-2 rounded-xl text-center text-xs font-bold font-barlow uppercase tracking-wider transition-all
                                        ${targetScope === key
                                            ? 'bg-kidville-green text-kidville-yellow shadow-md shadow-kidville-green/10'
                                            : 'text-kidville-muted hover:text-kidville-ink'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        {isEducator && (
                            <p className="text-[10px] text-kidville-muted mt-1.5 font-maven pl-1">
                                🔒 Puoi assegnare task a singole persone o alle tue classi.
                            </p>
                        )}
                    </div>

                    {/* Campi condizionali per destinatario */}
                    {targetScope === 'single' && (
                        <div className="space-y-4">
                            {/* Toggle Suddivisione Compiti */}
                            <div className="flex items-center justify-between p-3 bg-kidville-cream rounded-2xl border border-kidville-line">
                                <div className="pr-2">
                                    <span className="block text-xs font-bold text-kidville-green uppercase tracking-wide">
                                        Suddividi in Compiti
                                    </span>
                                    <span className="text-[10px] text-kidville-muted font-maven block mt-0.5">
                                        Crea più compiti da assegnare a persone diverse all&apos;interno di questo task.
                                    </span>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        className="sr-only peer" 
                                        checked={isSubdivided}
                                        onChange={e => {
                                            setIsSubdivided(e.target.checked);
                                            if (e.target.checked && compitiList.length === 0) {
                                                setCompitiList([{ id: crypto.randomUUID(), titolo: '', assigned_to: '' }]);
                                            }
                                        }}
                                    />
                                    <div className="w-9 h-5 bg-kidville-cream-dark peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-kidville-line after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-kidville-green"></div>
                                </label>
                            </div>

                            {/* Caso A: Task Singolo / Copie Multiple */}
                            {!isSubdivided && (
                                <div>
                                    <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-2">
                                        Assegna a uno o più destinatari:
                                    </label>
                                    <div className="grid grid-cols-2 gap-2 max-h-[150px] overflow-y-auto p-2 bg-kidville-cream border border-kidville-line/50 rounded-2xl">
                                        {staffMembers.map(member => {
                                            const isChecked = selectedAssignees.includes(member.id);
                                            return (
                                                <label 
                                                    key={member.id} 
                                                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs font-maven cursor-pointer transition-all
                                                        ${isChecked 
                                                            ? 'bg-kidville-green/10 border-kidville-green/45 text-kidville-green font-bold' 
                                                            : 'bg-white border-kidville-line text-kidville-muted'}`}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        className="rounded text-kidville-green focus:ring-kidville-green"
                                                        checked={isChecked}
                                                        onChange={() => {
                                                            if (isChecked) {
                                                                setSelectedAssignees(prev => prev.filter(id => id !== member.id));
                                                            } else {
                                                                setSelectedAssignees(prev => [...prev, member.id]);
                                                            }
                                                        }}
                                                    />
                                                    <span className="truncate">
                                                        {member.first_name} {member.last_name}
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                    <p className="text-[10px] text-kidville-muted mt-1.5 font-maven pl-1">
                                        💡 Se selezioni più destinatari, verrà creata una copia indipendente del task per ciascuno di essi.
                                    </p>
                                </div>
                            )}

                            {/* Caso B: Suddivisione in Compiti */}
                            {isSubdivided && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider">
                                            Elenco Compiti
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => setCompitiList(prev => [...prev, { id: crypto.randomUUID(), titolo: '', assigned_to: '' }])}
                                            className="text-xs font-bold text-kidville-green hover:underline flex items-center gap-1"
                                        >
                                            + Aggiungi compito
                                        </button>
                                    </div>

                                    <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1">
                                        {compitiList.map((compito) => (
                                            <div key={compito.id} className="flex gap-2 items-center p-3 bg-kidville-cream rounded-2xl border border-kidville-line">
                                                <div className="flex-1 space-y-2">
                                                    <input
                                                        type="text"
                                                        placeholder="Cosa fare? (es. Preparare pannolini)"
                                                        value={compito.titolo}
                                                        onChange={e => {
                                                            const newTitle = e.target.value;
                                                            setCompitiList(prev => prev.map(c => c.id === compito.id ? { ...c, titolo: newTitle } : c));
                                                        }}
                                                        className="w-full border border-kidville-line rounded-xl px-3 py-1.5 font-maven text-xs text-kidville-green bg-white focus:outline-none"
                                                    />
                                                    <select
                                                        value={compito.assigned_to}
                                                        onChange={e => {
                                                            const newAss = e.target.value;
                                                            setCompitiList(prev => prev.map(c => c.id === compito.id ? { ...c, assigned_to: newAss } : c));
                                                        }}
                                                        className="w-full border border-kidville-line rounded-xl px-2 py-1.5 font-maven text-xs text-kidville-green bg-white focus:outline-none"
                                                    >
                                                        <option value="">Assegna a...</option>
                                                        {staffMembers.map(member => (
                                                            <option key={member.id} value={member.id}>
                                                                {member.first_name} {member.last_name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                {compitiList.length > 1 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => setCompitiList(prev => prev.filter(c => c.id !== compito.id))}
                                                        className="p-2 text-kidville-muted hover:text-kidville-error rounded-xl hover:bg-kidville-error-soft transition-all flex-shrink-0"
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {targetScope === 'class' && (
                        <div>
                            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
                                Seleziona Classe / Sezione
                            </label>
                            <select
                                value={targetClass}
                                onChange={e => setTargetClass(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            >
                                <option value="">-- Seleziona --</option>
                                {visibleClasses.map(cls => (
                                    <option key={cls} value={cls}>{cls}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {targetScope === 'role' && (
                        <div>
                            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                                <Shield size={12} /> Seleziona Ruolo Destinatario
                            </label>
                            <select
                                value={targetRole}
                                onChange={e => setTargetRole(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                            >
                                <option value="educator">Insegnante (Educator)</option>
                                <option value="coordinator">Coordinatore (Coordinator)</option>
                                <option value="admin">Segreteria/Direzione (Admin)</option>
                            </select>
                        </div>
                    )}

                    {/* Associazione Alunno (Opzionale) */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
                            Associa ad un Alunno (Opzionale)
                        </label>
                        <select
                            value={studentId}
                            onChange={e => setStudentId(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-3 py-2.5 font-maven text-sm text-kidville-green bg-white/60 focus:outline-none focus:ring-2 focus:ring-kidville-green transition-all"
                        >
                            <option value="">-- Nessuno --</option>
                            {students.map(student => (
                                <option key={student.id} value={student.id}>
                                    {student.nome} {student.cognome} ({student.classe_sezione})
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Scadenza (Opzionale) */}
                    <div>
                        <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1 flex items-center gap-1">
                            <Calendar size={12} /> Scadenza (Opzionale)
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <input
                                type="date"
                                value={deadlineDate}
                                onChange={e => setDeadlineDate(e.target.value)}
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

                    {/* Pulsanti invia */}
                    <div className="flex gap-3 border-t border-kidville-line pt-5 mt-2">
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
                            {isSaving ? 'Creazione...' : 'Crea Task'}
                        </button>
                    </div>
                </form>
            </motion.div>
        </>
    );
}
