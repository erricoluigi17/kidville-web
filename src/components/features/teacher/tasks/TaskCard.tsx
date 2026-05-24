'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Clock, User, CheckCircle, Play, Trash2, Tag, Calendar,
    ChevronDown, ChevronUp, Edit2, Eye, AlertCircle, Lock,
    Paperclip, MessageSquare, Send, Download, ExternalLink,
    CheckSquare, RefreshCw, Undo, EyeOff
} from 'lucide-react';

export interface Task {
    id: string;
    author_id: string;
    assigned_to: string | null;
    assignees?: string[];
    target_class: string | null;
    target_role: string | null;
    target_scope: 'single' | 'class' | 'role' | 'global';
    titolo: string;
    descrizione?: string;
    contenuto?: string;
    status: 'todo' | 'in_progress' | 'completed' | 'approved';
    priority: 'low' | 'medium' | 'high' | 'urgent';
    category: string;
    deadline: string | null;
    student_id: string | null;
    resolved_by: string | null;
    resolution_notes: string | null;
    resolved_at: string | null;
    revision_feedback?: string | null;
    created_at: string;
    author: { first_name: string; last_name: string; role: string } | null;
    assignee: { first_name: string; last_name: string; role: string } | null;
    student: { nome: string; cognome: string; classe_sezione: string; allergies?: string[]; note_mediche?: string; allergie: string[] } | null;
    resolver: { first_name: string; last_name: string; role: string } | null;
    attachments?: Array<{ name: string; url: string; size: number; type: string }> | null;
    commenti?: Array<{
        id: string;
        author_id: string;
        author_name: string;
        testo: string;
        created_at: string;
        attachments?: Array<{ name: string; url: string; size: number; type: string }> | null;
    }> | null;
    compiti?: Array<{
        id: string;
        titolo: string;
        assigned_to: string;
        status: 'todo' | 'completed' | 'approved';
        resolution_notes?: string | null;
        resolved_at?: string | null;
        resolved_by?: string | null;
        assignee_name?: string;
        revision_feedback?: string | null;
        attachments?: Array<{ name: string; url: string; size: number; type: string }> | null;
        commenti?: Array<{
            id: string;
            author_id: string;
            author_name: string;
            testo: string;
            created_at: string;
            attachments?: Array<{ name: string; url: string; size: number; type: string }> | null;
        }> | null;
    }> | null;
}

interface TaskCardProps {
    task: Task;
    index: number;
    currentUserId: string;
    currentUserName?: string;
    currentUserRole: string;
    isUpdated?: boolean;
    onMarkRead?: () => void;
    onTakeCharge: (id: string) => void;
    onComplete: (task: Task) => void;
    onDelete?: (id: string) => void;
    onEdit?: (task: Task) => void;
    onResolveSubtask?: (taskId: string, subtaskId: string, notes: string, attachments?: any[]) => Promise<void>;
    onUpdateSubtasks?: (taskId: string, updatedCompiti: any[], toastMessage?: string) => Promise<void>;
    onUpdateTaskFields?: (taskId: string, updates: Record<string, unknown>, toastMessage?: string) => Promise<void>;
}

const priorityConfig = {
    low: { label: 'Bassa', style: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400', dot: 'bg-teal-400' },
    medium: { label: 'Media', style: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400', dot: 'bg-blue-400' },
    high: { label: 'Alta', style: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400', dot: 'bg-orange-400' },
    urgent: { label: 'Urgente', style: 'bg-red-500 text-white font-bold animate-pulse shadow-md shadow-red-500/20', dot: 'bg-red-500' }
};

const statusConfig = {
    todo: { label: 'Da Fare', dot: 'bg-zinc-300', bar: 'bg-zinc-100 text-zinc-500' },
    in_progress: { label: 'In Corso', dot: 'bg-amber-400', bar: 'bg-amber-55 text-amber-700 border-amber-200' },
    completed: { label: 'Da Controllare', dot: 'bg-blue-400', bar: 'bg-blue-50 text-blue-700 border-blue-200' },
    approved: { label: 'Completato', dot: 'bg-emerald-400', bar: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
};

export function TaskCard({
    task,
    index,
    currentUserId,
    currentUserName = 'Tu',
    currentUserRole,
    isUpdated = false,
    onMarkRead,
    onTakeCharge,
    onComplete,
    onDelete,
    onEdit,
    onResolveSubtask,
    onUpdateSubtasks,
    onUpdateTaskFields
}: TaskCardProps) {
    const isOwner = task.author_id === currentUserId;
    const isManager = currentUserRole === 'admin' || currentUserRole === 'coordinator';
    const canDelete = onDelete && (isOwner || isManager);
    const canEdit = onEdit && isManager;
    const hasCompiti = task.compiti && task.compiti.length > 0;

    // Determine if the current user is directly assigned (no subtasks)
    const isDirectAssignee = !hasCompiti && (task.assignees?.includes(currentUserId) || task.assigned_to === currentUserId);
    const canMarkComplete = isManager || isOwner || isDirectAssignee;

    const [expanded, setExpanded] = useState(false);
    const [now] = useState(() => Date.now());
    
    // Subtask Resolution
    const [resolvingSubtaskId, setResolvingSubtaskId] = useState<string | null>(null);
    const [subtaskNotes, setSubtaskNotes] = useState('');
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [isResolvingSubtask, setIsResolvingSubtask] = useState(false);

    // Comments / Clarifications
    const [showCommentsSubtaskId, setShowCommentsSubtaskId] = useState<string | null>(null);
    const [showTaskComments, setShowTaskComments] = useState(false);
    const [commentText, setCommentText] = useState('');
    const [commentFiles, setCommentFiles] = useState<File[]>([]);
    const [isUploadingCommentFile, setIsUploadingCommentFile] = useState(false);

    // Rejection / Revision States
    const [rejectingSubtaskId, setRejectingSubtaskId] = useState<string | null>(null);
    const [rejectingTaskId, setRejectingTaskId] = useState<string | null>(null);
    const [rejectFeedback, setRejectFeedback] = useState('');
    
    // Lightbox for Images
    const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

    useEffect(() => {
        if (expanded && isUpdated && onMarkRead) {
            onMarkRead();
        }
    }, [expanded, isUpdated, onMarkRead]);

    const createdDate = new Date(task.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const deadlineDate = task.deadline ? new Date(task.deadline) : null;
    const isExpired = deadlineDate ? deadlineDate.getTime() < now : false;
    const formattedDeadline = deadlineDate ? deadlineDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

    const descrizione = task.descrizione || task.contenuto || '';

    const getTargetText = () => {
        if (task.target_scope === 'global') return '🌍 Tutti lo staff';
        if (task.target_scope === 'role') return `👥 Ruolo: ${task.target_role === 'educator' ? 'Insegnanti' : task.target_role === 'coordinator' ? 'Coordinatori' : 'Segreteria'}`;
        if (task.target_scope === 'class') return `🏫 Classe: ${task.target_class}`;
        const allAssignees = task.assignees || (task.assigned_to ? [task.assigned_to] : []);
        if (allAssignees.length > 1) return `👥 ${allAssignees.length} persone`;
        return task.assignee ? `👤 ${task.assignee.first_name} ${task.assignee.last_name}` : '👤 Non assegnato';
    };

    // Helper to upload all files to backend
    const handleUploadAll = async (files: File[]) => {
        const uploaded = [];
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch('/api/tasks/upload', {
                method: 'POST',
                body: formData
            });
            if (res.ok) {
                const data = await res.json();
                uploaded.push(data);
            } else {
                throw new Error('Errore durante il caricamento del file');
            }
        }
        return uploaded;
    };

    // Render attachments grid with file types
    const renderAttachments = (attachmentsList?: any[] | null) => {
        if (!attachmentsList || attachmentsList.length === 0) return null;
        return (
            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {attachmentsList.map((att, idx) => {
                    const isImage = att.type?.startsWith('image/');
                    return (
                        <div key={idx} className="flex items-center gap-2 p-2 bg-zinc-50/50 dark:bg-zinc-900/50 border border-gray-150 dark:border-zinc-800 rounded-xl text-xs truncate max-w-full">
                            {isImage ? (
                                <button
                                    type="button"
                                    onClick={() => setLightboxUrl(att.fileUrl || att.url)}
                                    className="w-9 h-9 rounded-lg overflow-hidden bg-gray-100 dark:bg-zinc-800 flex-shrink-0 border border-gray-200 dark:border-zinc-700 hover:opacity-85 transition-opacity"
                                >
                                    <img src={att.fileUrl || att.url} alt={att.name} className="w-full h-full object-cover" />
                                </button>
                            ) : (
                                <div className="w-9 h-9 rounded-lg bg-kidville-cream dark:bg-zinc-900 flex items-center justify-center text-kidville-green dark:text-zinc-300 font-barlow font-bold text-[10px] flex-shrink-0 uppercase border border-gray-200 dark:border-zinc-800">
                                    {att.name.split('.').pop() || 'doc'}
                                </div>
                            )}
                            <div className="flex-1 min-w-0 pr-1 text-left">
                                <p className="font-maven font-bold text-zinc-700 dark:text-zinc-300 truncate text-[11px]" title={att.name}>
                                    {att.name}
                                </p>
                                <p className="text-[9px] text-zinc-400 font-medium">
                                    {att.size ? `${(att.size / 1024).toFixed(0)} KB` : 'Dettagli non disponibili'}
                                </p>
                            </div>
                            <a
                                href={att.fileUrl || att.url}
                                download={att.name}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 text-zinc-400 hover:text-kidville-green dark:hover:text-zinc-200 transition-colors"
                                title="Scarica o apri in nuova scheda"
                            >
                                <ExternalLink size={13} />
                            </a>
                        </div>
                    );
                })}
            </div>
        );
    };

    // Subtasks can be 'todo' | 'completed' | 'approved'
    const approvedSubtasks = task.compiti?.filter(c => c.status === 'approved').length || 0;
    const completedSubtasks = task.compiti?.filter(c => c.status === 'completed' || c.status === 'approved').length || 0;
    const totalSubtasks = task.compiti?.length || 0;
    const progressPct = totalSubtasks > 0 ? Math.round((approvedSubtasks / totalSubtasks) * 100) : 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05, duration: 0.3 }}
            className={`w-full backdrop-blur-xl rounded-3xl border shadow-sm transition-all duration-200 overflow-hidden relative
                ${task.status === 'approved' ? 'opacity-80' : ''}
                ${isUpdated 
                    ? 'bg-orange-50/70 dark:bg-orange-955/35 border-orange-500 dark:border-orange-400 ring-4 ring-orange-500/30 dark:ring-orange-400/30 shadow-lg shadow-orange-500/20' 
                    : task.status === 'approved' 
                        ? 'bg-white/90 dark:bg-zinc-950/90 border-zinc-100 dark:border-zinc-900' 
                        : 'bg-white/90 dark:bg-zinc-950/90 border-white/60 dark:border-zinc-800'}
                ${task.priority === 'urgent' && task.status !== 'approved' && !isUpdated ? 'ring-1 ring-red-400 dark:ring-red-900' : ''}`}
        >
            {/* Top bar: status color */}
            <div className={`h-0.5 w-full ${task.status === 'todo' ? 'bg-zinc-200' : task.status === 'in_progress' ? 'bg-amber-400' : task.status === 'completed' ? 'bg-blue-400' : 'bg-emerald-400'}`} />

            {isUpdated && (
                <div className="absolute left-0 top-0 bottom-0 w-2.5 bg-gradient-to-b from-orange-400 via-orange-500 to-amber-500 animate-pulse z-10" />
            )}

            <div className={`p-5 ${isUpdated ? 'pl-7' : ''}`}>
                {/* Header row */}
                <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        {isUpdated && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-orange-500 text-white rounded-full text-[10px] font-bold uppercase tracking-wider font-barlow animate-pulse">
                                ⚡ Aggiornato
                            </span>
                        )}
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-kidville-cream text-kidville-green rounded-full text-[10px] font-semibold uppercase tracking-wider font-barlow">
                            <Tag size={9} /> {task.category}
                        </span>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider font-barlow ${priorityConfig[task.priority].style}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${priorityConfig[task.priority].dot}`} />
                            {priorityConfig[task.priority].label}
                        </span>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold border ${statusConfig[task.status].bar}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${statusConfig[task.status].dot}`} />
                            {statusConfig[task.status].label}
                        </span>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                        {canEdit && (
                            <button
                                onClick={() => onEdit!(task)}
                                className="p-1.5 text-zinc-400 hover:text-kidville-green rounded-lg hover:bg-kidville-cream transition-colors"
                                title="Modifica task"
                            >
                                <Edit2 size={13} />
                            </button>
                        )}
                        {canDelete && (
                            <button
                                onClick={() => onDelete!(task.id)}
                                className="p-1.5 text-zinc-400 hover:text-red-500 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                                title="Elimina task"
                            >
                                <Trash2 size={13} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Title */}
                <h3 className={`font-barlow font-bold text-left text-base text-kidville-green dark:text-zinc-50 uppercase tracking-wide mb-1 leading-snug ${task.status === 'approved' ? 'line-through text-gray-400 dark:text-zinc-600' : ''}`}>
                    {task.titolo}
                </h3>

                {/* Quick info line */}
                <div className="flex items-center gap-3 text-[11px] text-zinc-400 mb-3">
                    <span className="flex items-center gap-1">
                        <User size={10} /> {task.author ? `${task.author.first_name} ${task.author.last_name}` : 'Segreteria'}
                    </span>
                    <span>→</span>
                    <span>{getTargetText()}</span>
                    {formattedDeadline && (
                        <>
                            <span>·</span>
                            <span className={`flex items-center gap-1 ${isExpired && task.status !== 'approved' ? 'text-red-500 font-bold' : ''}`}>
                                <Calendar size={10} /> {formattedDeadline}
                            </span>
                        </>
                    )}
                </div>

                {/* Progress bar for compiti */}
                {hasCompiti && (
                    <div className="mb-3">
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Compiti Approvati</span>
                            <span className="text-[10px] font-bold text-kidville-green">{approvedSubtasks}/{totalSubtasks} (Risolti: {completedSubtasks})</span>
                        </div>
                        <div className="h-1.5 bg-zinc-100 dark:bg-zinc-900 rounded-full overflow-hidden">
                            <motion.div
                                className="h-full bg-kidville-green rounded-full"
                                initial={{ width: 0 }}
                                animate={{ width: `${progressPct}%` }}
                                transition={{ duration: 0.5, ease: 'easeOut' }}
                            />
                        </div>
                    </div>
                )}

                {/* Expand/collapse button */}
                <button
                    onClick={() => setExpanded(v => !v)}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold text-kidville-green/60 hover:text-kidville-green uppercase tracking-wider transition-colors"
                >
                    {expanded ? <EyeOff size={11} /> : <Eye size={11} />}
                    {expanded ? 'Nascondi dettagli' : 'Vedi dettagli'}
                    {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
            </div>

            {/* Expandable details */}
            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        className="overflow-hidden border-t border-gray-100/60 dark:border-zinc-900"
                    >
                        <div className="p-5 space-y-4">
                            {/* Full description */}
                            {descrizione && (
                                <div className="p-4 bg-zinc-50/80 dark:bg-zinc-900/40 rounded-2xl border border-gray-100 dark:border-zinc-800 text-left">
                                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                                        📋 Istruzioni
                                    </p>
                                    <p className="font-maven text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-line leading-relaxed">
                                        {descrizione}
                                    </p>
                                </div>
                            )}

                            {/* Student info */}
                            {task.student && (
                                <div className={`p-3.5 rounded-2xl border flex items-start gap-2.5
                                    ${task.student.allergie.length > 0
                                        ? 'bg-red-50/50 dark:bg-red-950/10 border-red-100 dark:border-red-900/30'
                                        : 'bg-kidville-cream/20 dark:bg-zinc-900/30 border-gray-100 dark:border-zinc-800'}`}>
                                    <div className="w-9 h-9 rounded-full bg-kidville-cream flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs text-kidville-green">
                                        {task.student.nome[0]}{task.student.cognome[0]}
                                    </div>
                                    <div className="flex-1 min-w-0 text-left">
                                        <p className="font-maven font-bold text-xs text-kidville-green dark:text-zinc-200">
                                            👶 Alunno: {task.student.nome} {task.student.cognome}
                                        </p>
                                        <p className="font-maven text-[10px] text-zinc-400">Sezione: {task.student.classe_sezione}</p>
                                        {task.student.allergie.length > 0 && (
                                            <p className="font-maven text-[10px] text-red-600 dark:text-red-400 font-bold mt-0.5">
                                                ⚠️ Allergie: {task.student.allergie.join(', ')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Task level revision feedback if rejected */}
                            {!hasCompiti && task.revision_feedback && task.status !== 'approved' && (
                                <div className="p-3 bg-red-50 dark:bg-red-950/15 border border-red-200 rounded-2xl text-[11px] text-red-700 dark:text-red-400 text-left leading-relaxed">
                                    <strong>⚠️ Revisione Richiesta:</strong> &ldquo;{task.revision_feedback}&rdquo;
                                    <p className="text-[9px] text-zinc-400 mt-1">Correggi e risolvi nuovamente il task allegando i file corretti.</p>
                                </div>
                            )}

                            {/* Task-level comments thread for direct tasks */}
                            {!hasCompiti && (
                                <div className="p-4 bg-zinc-50/50 dark:bg-zinc-900/20 rounded-2xl border border-gray-150 dark:border-zinc-850 text-left space-y-2">
                                    <button
                                        type="button"
                                        onClick={() => setShowTaskComments(v => !v)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-750 dark:text-zinc-300 rounded-xl text-[10px] font-bold uppercase transition-all border border-gray-250 dark:border-zinc-700 cursor-pointer"
                                    >
                                        <MessageSquare size={11} />
                                        Chiarimenti ({(task.commenti || []).length})
                                    </button>

                                    {showTaskComments && (
                                        <div className="space-y-3 pt-1">
                                            {task.commenti && task.commenti.length > 0 ? (
                                                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                                    {task.commenti.map(comm => (
                                                        <div key={comm.id} className="p-2.5 bg-white dark:bg-zinc-950 rounded-xl border border-gray-150 dark:border-zinc-900 text-xs text-left">
                                                            <div className="flex items-center justify-between text-[9px] text-zinc-400 mb-1">
                                                                <span className="font-bold text-kidville-green dark:text-zinc-300">{comm.author_name}</span>
                                                                <span>{new Date(comm.created_at).toLocaleDateString('it-IT', {day: '2-digit', month: '2-digit', hour:'2-digit', minute:'2-digit'})}</span>
                                                            </div>
                                                            <p className="font-maven text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-line">{comm.testo}</p>
                                                            {renderAttachments(comm.attachments)}
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="font-maven text-xs text-zinc-400 italic py-1">Nessun chiarimento presente per questo task.</p>
                                            )}

                                            {/* Form to submit task-level clarification */}
                                            <div className="space-y-2 border-t border-dashed border-gray-200 dark:border-zinc-800 pt-2.5">
                                                <textarea
                                                    rows={2}
                                                    placeholder="Scrivi una domanda o chiedi chiarimenti su questo task..."
                                                    value={commentText}
                                                    onChange={e => setCommentText(e.target.value)}
                                                    className="w-full border border-gray-250 dark:border-zinc-800 rounded-xl px-3 py-2 font-maven text-xs text-kidville-green dark:text-zinc-200 bg-white dark:bg-zinc-950 focus:outline-none focus:ring-1 focus:ring-kidville-green focus:border-transparent transition-all"
                                                />
                                                <div className="flex items-center justify-between gap-1">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <label className="p-1.5 border border-gray-200 dark:border-zinc-800 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-900 text-zinc-400 hover:text-kidville-green transition-colors" title="Allega file">
                                                            <Paperclip size={13} />
                                                            <input 
                                                                type="file" 
                                                                multiple 
                                                                onChange={e => {
                                                                    if (e.target.files) {
                                                                        setCommentFiles(Array.from(e.target.files));
                                                                    }
                                                                }}
                                                                className="hidden"
                                                                accept="image/*,.pdf,.doc,.docx"
                                                            />
                                                        </label>
                                                        {commentFiles.map((file, fIdx) => (
                                                            <span key={fIdx} className="inline-flex items-center gap-0.5 px-2 py-0.5 bg-zinc-100 rounded text-[9px] text-zinc-500">
                                                                {file.name.substring(0, 10)}...
                                                                <button type="button" onClick={() => setCommentFiles(prev => prev.filter((_, i) => i !== fIdx))} className="text-red-500 hover:text-red-700 ml-1 font-bold">✕</button>
                                                            </span>
                                                        ))}
                                                    </div>

                                                    <button
                                                        type="button"
                                                        disabled={(!commentText.trim() && commentFiles.length === 0) || isUploadingCommentFile}
                                                        onClick={async () => {
                                                            setIsUploadingCommentFile(true);
                                                            try {
                                                                let atts = [];
                                                                if (commentFiles.length > 0) {
                                                                    atts = await handleUploadAll(commentFiles);
                                                                }
                                                                
                                                                const newComm = {
                                                                    id: Math.random().toString(36).substring(2, 9),
                                                                    author_id: currentUserId,
                                                                    author_name: currentUserName,
                                                                    testo: commentText,
                                                                    created_at: new Date().toISOString(),
                                                                    attachments: atts
                                                                };

                                                                if (onUpdateTaskFields) {
                                                                    await onUpdateTaskFields(task.id, {
                                                                        commenti: [...(task.commenti || []), newComm]
                                                                    }, "Chiarimento inviato! 💬");
                                                                    setCommentText('');
                                                                    setCommentFiles([]);
                                                                }
                                                            } catch (err: any) {
                                                                alert(err.message || 'Errore');
                                                            } finally {
                                                                setIsUploadingCommentFile(false);
                                                            }
                                                        }}
                                                        className="px-3 py-1.5 bg-kidville-green text-kidville-yellow rounded-xl text-xs font-bold uppercase hover:opacity-90 transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                                                    >
                                                        {isUploadingCommentFile ? 'Invio...' : <><Send size={11} /> Invia</>}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Compiti / Subtasks */}
                            {hasCompiti && (
                                <div className="space-y-2 text-left">
                                    <h4 className="font-barlow font-bold text-[10px] text-kidville-green dark:text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                                        📋 Compiti Suddivisi ({approvedSubtasks}/{totalSubtasks})
                                    </h4>
                                    <div className="space-y-2">
                                        {task.compiti!.map((compito) => {
                                            const isCompitoCompleted = compito.status === 'completed' || compito.status === 'approved';
                                            const isCompitoApproved = compito.status === 'approved';
                                            const isCompitoPending = compito.status === 'completed';
                                            const isAssignedToMe = compito.assigned_to === currentUserId;
                                            
                                            // Assignee or managers can resolve a subtask if it's todo or rejected
                                            const canResolve = (isAssignedToMe || isManager) && !isCompitoCompleted && task.status !== 'approved';
                                            const isResolvingThis = resolvingSubtaskId === compito.id;

                                            return (
                                                <div
                                                    key={compito.id}
                                                    className={`p-3.5 rounded-2xl border transition-all space-y-2
                                                        ${isCompitoApproved
                                                            ? 'bg-emerald-50/20 dark:bg-emerald-950/5 border-emerald-150 dark:border-emerald-900/20'
                                                            : isCompitoPending
                                                            ? 'bg-blue-50/10 dark:bg-blue-950/5 border-blue-200/50 dark:border-blue-900/20'
                                                            : isAssignedToMe
                                                                ? 'bg-amber-50/30 dark:bg-amber-955/10 border-amber-200/50 dark:border-amber-900/20 shadow-sm'
                                                                : 'bg-white dark:bg-zinc-950 border-gray-100 dark:border-zinc-900'}`}
                                                >
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="flex items-start gap-2 min-w-0">
                                                            <span className={`mt-0.5 flex-shrink-0 ${isCompitoApproved ? 'text-emerald-500' : isCompitoPending ? 'text-blue-500' : isAssignedToMe ? 'text-amber-500' : 'text-zinc-300'}`}>
                                                                {isCompitoApproved ? <CheckCircle size={14} /> : <CheckSquare size={14} />}
                                                            </span>
                                                            <div className="min-w-0">
                                                                <p className={`font-maven text-xs font-semibold leading-snug ${isCompitoApproved ? 'line-through text-zinc-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
                                                                    {compito.titolo}
                                                                </p>
                                                                <p className="font-maven text-[10px] text-zinc-400 mt-0.5">
                                                                    👤 {compito.assignee_name || 'Non specificato'}
                                                                    {isAssignedToMe && !isCompitoCompleted && (
                                                                        <span className="ml-1 text-amber-600 font-bold">(tu)</span>
                                                                    )}
                                                                </p>
                                                            </div>
                                                        </div>

                                                        <div className="flex-shrink-0">
                                                            {!canResolve && !isCompitoCompleted && !isAssignedToMe && (
                                                                <span className="text-zinc-300" title="Solo la persona assegnata può completare">
                                                                    <Lock size={11} />
                                                                </span>
                                                            )}
                                                            {canResolve && !isResolvingThis && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => { 
                                                                        setResolvingSubtaskId(compito.id); 
                                                                        setSubtaskNotes(''); 
                                                                        setSelectedFiles([]);
                                                                    }}
                                                                    className="px-2.5 py-1 bg-amber-400 hover:bg-amber-500 active:scale-[0.98] text-zinc-900 font-barlow font-bold text-[10px] uppercase rounded-lg tracking-wider transition-all shadow-sm cursor-pointer"
                                                                >
                                                                    Completa Compito ✓
                                                                </button>
                                                            )}
                                                            {isResolvingThis && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => { setResolvingSubtaskId(null); setSubtaskNotes(''); setSelectedFiles([]); }}
                                                                    className="text-[10px] font-bold text-zinc-400 hover:text-zinc-600 uppercase tracking-wider"
                                                                >
                                                                    Annulla
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Revision Alert for Subtask */}
                                                    {!isCompitoCompleted && compito.revision_feedback && (
                                                        <div className="bg-red-50 dark:bg-red-950/10 border border-red-100 dark:border-red-900/20 p-2.5 rounded-xl text-[10px] text-red-700 dark:text-red-400">
                                                            <strong>⚠️ Modifica richiesta:</strong> &ldquo;{compito.revision_feedback}&rdquo;
                                                        </div>
                                                    )}

                                                    {/* Inline resolution form with file uploader */}
                                                    {isResolvingThis && (
                                                        <div className="mt-2 pt-2 border-t border-dashed border-gray-100 dark:border-zinc-800 space-y-3">
                                                            <textarea
                                                                rows={2}
                                                                placeholder="Come hai completato questo compito? Spiega cosa hai fatto... *"
                                                                value={subtaskNotes}
                                                                onChange={e => setSubtaskNotes(e.target.value)}
                                                                className="w-full border border-gray-200 dark:border-zinc-800 rounded-xl p-2 font-maven text-xs text-kidville-green dark:text-zinc-200 bg-zinc-50/50 dark:bg-zinc-900/50 focus:outline-none focus:ring-1 focus:ring-amber-400"
                                                                autoFocus
                                                            />
                                                            
                                                            {/* Styled File Upload */}
                                                            <div className="space-y-1.5">
                                                                <div className="flex flex-wrap gap-1.5 items-center">
                                                                    <label className="flex items-center gap-1 px-2.5 py-1.5 border border-dashed border-gray-300 dark:border-zinc-700 hover:border-kidville-green rounded-xl cursor-pointer font-maven text-[10px] font-bold text-zinc-500 hover:text-kidville-green transition-all uppercase">
                                                                        <Paperclip size={11} /> Allega File
                                                                        <input 
                                                                            type="file" 
                                                                            multiple 
                                                                            onChange={e => {
                                                                                if (e.target.files) {
                                                                                    setSelectedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                                                                                }
                                                                            }}
                                                                            className="hidden" 
                                                                            accept="image/*,.pdf,.doc,.docx"
                                                                        />
                                                                    </label>
                                                                    {selectedFiles.map((file, fIdx) => (
                                                                        <span key={fIdx} className="inline-flex items-center gap-0.5 px-2 py-1 bg-zinc-100 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-850 rounded-lg text-[9px] text-zinc-500">
                                                                            {file.name.substring(0, 15)}...
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => setSelectedFiles(prev => prev.filter((_, i) => i !== fIdx))}
                                                                                className="text-red-500 hover:text-red-700 ml-1 font-bold"
                                                                            >✕</button>
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            </div>

                                                            <div className="flex justify-end gap-1.5 pt-1">
                                                                <button
                                                                    type="button"
                                                                    disabled={isResolvingSubtask}
                                                                    onClick={async () => {
                                                                        if (!subtaskNotes.trim()) { alert('Inserisci le note di risoluzione!'); return; }
                                                                        setIsResolvingSubtask(true);
                                                                        try {
                                                                            let uploadedAttachments = [];
                                                                            if (selectedFiles.length > 0) {
                                                                                uploadedAttachments = await handleUploadAll(selectedFiles);
                                                                            }

                                                                            if (onResolveSubtask) {
                                                                                await onResolveSubtask(task.id, compito.id, subtaskNotes, uploadedAttachments);
                                                                                setResolvingSubtaskId(null);
                                                                                setSubtaskNotes('');
                                                                                setSelectedFiles([]);
                                                                            }
                                                                        } catch (err: any) { 
                                                                            alert(err.message || 'Errore durante il completamento');
                                                                        } finally { 
                                                                            setIsResolvingSubtask(false); 
                                                                        }
                                                                    }}
                                                                    className="px-3 py-1.5 bg-kidville-green text-kidville-yellow font-bold text-[10px] uppercase rounded-xl hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50"
                                                                >
                                                                    {isResolvingSubtask ? 'Salvataggio...' : 'Conferma'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Resolution notes & files */}
                                                    {isCompitoCompleted && compito.resolution_notes && (
                                                        <div className="mt-1.5 p-2.5 bg-emerald-50/30 dark:bg-emerald-950/10 border border-emerald-100/50 dark:border-emerald-900/30 rounded-xl text-[10px] space-y-1">
                                                            <div className="flex items-center justify-between">
                                                                <span className={`font-bold font-barlow uppercase text-[9px] ${isCompitoApproved ? 'text-emerald-700 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}`}>
                                                                    {isCompitoApproved ? '✅ Approvato' : '⏳ In Attesa Di Approvazione'}
                                                                </span>
                                                                {compito.resolved_at && (
                                                                    <span className="text-zinc-400 text-[8px]">
                                                                        {new Date(compito.resolved_at).toLocaleDateString('it-IT', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="text-zinc-700 dark:text-zinc-300 italic font-maven text-left">&ldquo;{compito.resolution_notes}&rdquo;</p>
                                                            {renderAttachments(compito.attachments)}
                                                        </div>
                                                    )}

                                                    {/* Manager Approval / Rejection UI */}
                                                    {isManager && isCompitoPending && (
                                                        <div className="mt-2.5 pt-2 border-t border-dashed border-gray-150 dark:border-zinc-800 flex flex-col gap-2">
                                                            {rejectingSubtaskId !== compito.id ? (
                                                                <div className="flex gap-2 justify-end">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setRejectingSubtaskId(compito.id)}
                                                                        className="px-2 py-1 bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-955/20 dark:text-red-400 text-[9px] font-bold uppercase rounded-lg tracking-wider transition-colors"
                                                                    >
                                                                        Richiedi Modifica
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={async () => {
                                                                            const updatedCompiti = task.compiti!.map(c => {
                                                                                if (c.id === compito.id) {
                                                                                    return {
                                                                                        ...c,
                                                                                        status: 'approved' as const,
                                                                                        revision_feedback: null
                                                                                    };
                                                                                }
                                                                                return c;
                                                                            });
                                                                            if (onUpdateSubtasks) {
                                                                                await onUpdateSubtasks(task.id, updatedCompiti, "Compito approvato! ✓");
                                                                            }
                                                                        }}
                                                                        className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white text-[9px] font-bold uppercase rounded-lg tracking-wider transition-colors"
                                                                    >
                                                                        Approva Compito
                                                                    </button>
                                                                </div>
                                                            ) : (
                                                                <div className="space-y-1.5 text-right">
                                                                    <textarea
                                                                        rows={2}
                                                                        placeholder="Specifica cosa deve modificare l'insegnante... *"
                                                                        value={rejectFeedback}
                                                                        onChange={e => setRejectFeedback(e.target.value)}
                                                                        className="w-full border border-red-200 dark:border-red-900 rounded-xl p-2 font-maven text-xs text-red-700 bg-red-50/20 focus:outline-none focus:ring-1 focus:ring-red-400"
                                                                        autoFocus
                                                                    />
                                                                    <div className="flex justify-end gap-1">
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => { setRejectingSubtaskId(null); setRejectFeedback(''); }}
                                                                            className="px-2 py-1 text-[9px] font-bold text-zinc-400 uppercase"
                                                                        >
                                                                            Annulla
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            disabled={!rejectFeedback.trim()}
                                                                            onClick={async () => {
                                                                                const updatedCompiti = task.compiti!.map(c => {
                                                                                    if (c.id === compito.id) {
                                                                                        return {
                                                                                            ...c,
                                                                                            status: 'todo' as const,
                                                                                            revision_feedback: rejectFeedback,
                                                                                            resolved_by: null,
                                                                                            resolved_at: null,
                                                                                            resolution_notes: null
                                                                                        };
                                                                                    }
                                                                                    return c;
                                                                                });
                                                                                if (onUpdateSubtasks) {
                                                                                    await onUpdateSubtasks(task.id, updatedCompiti, "Richiesta modifica inviata! ↺");
                                                                                    setRejectingSubtaskId(null);
                                                                                    setRejectFeedback('');
                                                                                }
                                                                            }}
                                                                            className="px-2 py-1 bg-red-500 hover:bg-red-600 text-white text-[9px] font-bold uppercase rounded-lg"
                                                                        >
                                                                            Invia Feedback
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}

                                                    {/* Comments / Clarifications sub-thread */}
                                                    <div className="mt-2 pt-2 border-t border-gray-50 dark:border-zinc-900">
                                                        <button
                                                            type="button"
                                                            onClick={() => setShowCommentsSubtaskId(showCommentsSubtaskId === compito.id ? null : compito.id)}
                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-xl text-[9px] font-bold uppercase transition-all border border-gray-200 dark:border-zinc-700 cursor-pointer"
                                                        >
                                                            <MessageSquare size={10} />
                                                            Chiarimenti ({(compito.commenti || []).length})
                                                        </button>

                                                        {showCommentsSubtaskId === compito.id && (
                                                            <div className="mt-2 space-y-2 pl-2 border-l-2 border-zinc-100 dark:border-zinc-900">
                                                                {compito.commenti && compito.commenti.length > 0 ? (
                                                                    <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                                                        {compito.commenti.map(comm => (
                                                                            <div key={comm.id} className="p-2 bg-zinc-50/85 dark:bg-zinc-900/30 rounded-xl border border-gray-100/50 dark:border-zinc-850 text-[10px] text-left">
                                                                                <div className="flex items-center justify-between text-[8px] text-zinc-400 mb-0.5">
                                                                                    <span className="font-bold text-kidville-green dark:text-zinc-300">{comm.author_name}</span>
                                                                                    <span>{new Date(comm.created_at).toLocaleDateString('it-IT', {hour:'2-digit', minute:'2-digit'})}</span>
                                                                                </div>
                                                                                <p className="font-maven text-zinc-700 dark:text-zinc-300 leading-snug">{comm.testo}</p>
                                                                                {renderAttachments(comm.attachments)}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                ) : (
                                                                    <p className="font-maven text-[9px] text-zinc-400 italic py-1">Nessun chiarimento presente.</p>
                                                                )}

                                                                {/* Form to submit clarification */}
                                                                <div className="space-y-1.5 pt-1">
                                                                    <textarea
                                                                        rows={1}
                                                                        placeholder="Chiedi o scrivi chiarimenti..."
                                                                        value={commentText}
                                                                        onChange={e => setCommentText(e.target.value)}
                                                                        className="w-full border border-gray-200 dark:border-zinc-855 rounded-xl px-2 py-1.5 font-maven text-xs text-kidville-green dark:text-zinc-200 bg-white/50 focus:outline-none focus:ring-1 focus:ring-kidville-green focus:border-transparent transition-all"
                                                                    />
                                                                    <div className="flex items-center justify-between gap-1">
                                                                        <div className="flex items-center gap-1 flex-wrap">
                                                                            <label className="p-1 border border-gray-200 dark:border-zinc-805 rounded-lg cursor-pointer hover:bg-gray-50 text-zinc-400 hover:text-kidville-green transition-colors" title="Allega file">
                                                                                <Paperclip size={11} />
                                                                                <input 
                                                                                    type="file" 
                                                                                    multiple 
                                                                                    onChange={e => {
                                                                                        if (e.target.files) {
                                                                                            setCommentFiles(Array.from(e.target.files));
                                                                                        }
                                                                                    }}
                                                                                    className="hidden"
                                                                                    accept="image/*,.pdf,.doc,.docx"
                                                                                />
                                                                            </label>
                                                                            {commentFiles.map((file, fIdx) => (
                                                                                <span key={fIdx} className="inline-flex items-center gap-0.5 px-1 bg-zinc-150 rounded text-[8px] text-zinc-500">
                                                                                    {file.name.substring(0, 8)}...
                                                                                    <button type="button" onClick={() => setCommentFiles(prev => prev.filter((_, i) => i !== fIdx))} className="text-red-500 hover:text-red-700">✕</button>
                                                                                </span>
                                                                            ))}
                                                                        </div>

                                                                        <button
                                                                            type="button"
                                                                            disabled={(!commentText.trim() && commentFiles.length === 0) || isUploadingCommentFile}
                                                                            onClick={async () => {
                                                                                setIsUploadingCommentFile(true);
                                                                                try {
                                                                                    let atts = [];
                                                                                    if (commentFiles.length > 0) {
                                                                                        atts = await handleUploadAll(commentFiles);
                                                                                    }
                                                                                    
                                                                                    const newComm = {
                                                                                        id: Math.random().toString(36).substring(2, 9),
                                                                                        author_id: currentUserId,
                                                                                        author_name: currentUserName,
                                                                                        testo: commentText,
                                                                                        created_at: new Date().toISOString(),
                                                                                        attachments: atts
                                                                                    };

                                                                                    const updatedCompiti = task.compiti!.map(c => {
                                                                                        if (c.id === compito.id) {
                                                                                            return {
                                                                                                ...c,
                                                                                                commenti: [...(c.commenti || []), newComm]
                                                                                            };
                                                                                        }
                                                                                        return c;
                                                                                    });

                                                                                    if (onUpdateSubtasks) {
                                                                                        await onUpdateSubtasks(task.id, updatedCompiti, "Chiarimento inviato! 💬");
                                                                                        setCommentText('');
                                                                                        setCommentFiles([]);
                                                                                    }
                                                                                } catch (err: any) {
                                                                                    alert(err.message || 'Errore');
                                                                                } finally {
                                                                                    setIsUploadingCommentFile(false);
                                                                                }
                                                                            }}
                                                                            className="px-2 py-1 bg-kidville-green text-kidville-yellow rounded-lg text-[9px] font-bold uppercase hover:opacity-90 transition-all flex items-center gap-1 disabled:opacity-50"
                                                                        >
                                                                            {isUploadingCommentFile ? 'Invio...' : <><Send size={9} /> Invia</>}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Main Task Completion Details */}
                            {(task.status === 'completed' || task.status === 'approved') && (
                                <div className="p-4 bg-emerald-50/20 dark:bg-emerald-950/10 border border-emerald-100 dark:border-emerald-900/20 rounded-2xl text-left">
                                    <p className="font-maven font-bold text-xs text-emerald-800 dark:text-emerald-400 flex items-center gap-1.5">
                                        <CheckCircle size={12} /> {task.status === 'approved' ? 'Risolto e Approvato da:' : 'Risolto da (in attesa di verifica):'} {task.resolver ? `${task.resolver.first_name} ${task.resolver.last_name}` : 'Staff'}
                                    </p>
                                    {task.resolved_at && (
                                        <p className="font-maven text-[10px] text-zinc-400 mt-0.5">
                                            il {new Date(task.resolved_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    )}
                                    {task.resolution_notes && (
                                        <p className="font-maven text-xs text-zinc-600 dark:text-zinc-300 mt-2 bg-white/40 dark:bg-zinc-900/40 p-2.5 rounded-xl border border-gray-100/50 dark:border-zinc-800 italic leading-relaxed">
                                            &ldquo;{task.resolution_notes}&rdquo;
                                        </p>
                                    )}
                                    
                                    {/* Task Level Attachments */}
                                    {task.attachments && task.attachments.length > 0 && (
                                        <div className="mt-3 border-t border-dashed border-emerald-100/50 dark:border-zinc-800 pt-3">
                                            <p className="font-barlow font-bold text-[9px] text-kidville-green uppercase tracking-wider mb-1">📁 Documenti Allegati</p>
                                            {renderAttachments(task.attachments)}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Meta footer */}
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-zinc-400 dark:text-zinc-500 pt-1 border-t border-gray-50 dark:border-zinc-900">
                                <span className="flex items-center gap-1"><Clock size={9} /> {createdDate}</span>
                                {isExpired && task.status !== 'approved' && (
                                    <span className="flex items-center gap-1 text-red-500 font-bold animate-pulse">
                                        <AlertCircle size={9} /> SCADUTO {formattedDeadline}
                                    </span>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Actions footer (always visible when not approved) */}
            {task.status !== 'approved' && (
                <div className={`flex flex-col sm:flex-row gap-2 px-5 pb-5 ${expanded ? '' : 'pt-0'} justify-between items-center border-t border-gray-50/50 dark:border-zinc-900/50 pt-4`}>
                    {/* Status Badge left side */}
                    <div>
                        {task.status === 'completed' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200">
                                ⏳ In Attesa di Approvazione
                            </span>
                        )}
                    </div>

                    <div className="flex gap-2">
                        {/* Show "take charge" only if directly assigned (no subtasks case), not yet in progress */}
                        {task.status === 'todo' && isDirectAssignee && (
                            <button
                                onClick={() => onTakeCharge(task.id)}
                                className="flex items-center gap-1 px-3 py-2 border-2 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-955/15 text-amber-700 dark:text-amber-500 font-barlow font-bold text-[10px] uppercase rounded-xl active:scale-[0.98] transition-all"
                            >
                                <Play size={11} /> Prendo in carico
                            </button>
                        )}
                        {/* Resolve task — only for managers/owners/direct assignees (not subtask tasks) when task is todo or in_progress */}
                        {canMarkComplete && !hasCompiti && (task.status === 'todo' || task.status === 'in_progress') && (
                            <button
                                onClick={() => onComplete(task)}
                                className="flex items-center gap-1 px-3 py-2 bg-kidville-green text-kidville-yellow hover:opacity-90 font-barlow font-bold text-[10px] uppercase rounded-xl active:scale-[0.98] transition-all shadow shadow-kidville-green/20"
                            >
                                <CheckCircle size={11} /> Risolvi Task
                            </button>
                        )}

                        {/* Manager approval actions for completed task (both direct and subtasks) */}
                        {isManager && task.status === 'completed' && (
                            <div className="flex gap-2">
                                {rejectingTaskId !== task.id ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => setRejectingTaskId(task.id)}
                                            className="flex items-center gap-1 px-3 py-2 border-2 border-red-200 hover:bg-red-50 text-red-600 font-barlow font-bold text-[10px] uppercase rounded-xl transition-all"
                                        >
                                            Richiedi Modifica
                                        </button>
                                        
                                        {/* If it has subtasks, only allow approving if all subtasks are approved */}
                                        {(!hasCompiti || task.compiti?.every(c => c.status === 'approved')) ? (
                                            <button
                                                type="button"
                                                onClick={async () => {
                                                    if (onUpdateTaskFields) {
                                                        await onUpdateTaskFields(task.id, { status: 'approved' }, "Task approvato e archiviato! 🎉");
                                                    }
                                                }}
                                                className="flex items-center gap-1 px-3 py-2 bg-emerald-500 text-white hover:bg-emerald-600 font-barlow font-bold text-[10px] uppercase rounded-xl transition-all shadow"
                                            >
                                                Approva Task
                                            </button>
                                        ) : (
                                            <span className="flex items-center gap-1 px-3 py-2 bg-zinc-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 font-barlow font-bold text-[10px] uppercase rounded-xl border border-gray-200 dark:border-zinc-800 cursor-not-allowed" title="Approva prima tutti i compiti suddivisi">
                                                In attesa approvazione compiti
                                            </span>
                                        )}
                                    </>
                                ) : (
                                    <div className="flex flex-col gap-1.5 text-right w-64">
                                        <textarea
                                            rows={2}
                                            placeholder="Motivo per la modifica del task... *"
                                            value={rejectFeedback}
                                            onChange={e => setRejectFeedback(e.target.value)}
                                            className="w-full border border-red-200 dark:border-zinc-800 rounded-xl p-2 font-maven text-xs text-red-700 dark:text-red-400 bg-red-50/20 dark:bg-red-955/10 focus:outline-none focus:ring-1 focus:ring-red-400"
                                            autoFocus
                                        />
                                        <div className="flex justify-end gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => { setRejectingTaskId(null); setRejectFeedback(''); }}
                                                className="px-2.5 py-1 text-[9px] font-bold text-zinc-400 uppercase"
                                            >
                                                Annulla
                                            </button>
                                            <button
                                                type="button"
                                                disabled={!rejectFeedback.trim()}
                                                onClick={async () => {
                                                    if (onUpdateTaskFields) {
                                                        await onUpdateTaskFields(task.id, {
                                                            status: 'todo',
                                                            revision_feedback: rejectFeedback,
                                                            resolved_by: null,
                                                            resolved_at: null,
                                                            resolution_notes: null,
                                                            attachments: [],
                                                            ...(hasCompiti ? {
                                                                compiti: task.compiti?.map(c => ({
                                                                    ...c,
                                                                    status: c.status === 'completed' || c.status === 'approved' ? 'todo' : c.status,
                                                                    revision_feedback: c.status === 'completed' || c.status === 'approved' ? rejectFeedback : c.revision_feedback,
                                                                    resolved_by: null,
                                                                    resolved_at: null,
                                                                    resolution_notes: null
                                                                }))
                                                            } : {})
                                                        }, "Richiesta modifica inviata! ↺");
                                                        setRejectingTaskId(null);
                                                        setRejectFeedback('');
                                                    }
                                                }}
                                                className="px-3 py-1 bg-red-500 text-white text-[9px] font-bold uppercase rounded-lg"
                                            >
                                                Invia
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Image Lightbox Modal */}
            {lightboxUrl && (
                <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[100] flex items-center justify-center p-4">
                    <button
                        onClick={() => setLightboxUrl(null)}
                        className="absolute top-6 right-6 w-10 h-10 bg-white/10 hover:bg-white/20 text-white rounded-full flex items-center justify-center transition-colors text-sm font-bold"
                    >
                        ✕
                    </button>
                    <img src={lightboxUrl} alt="Allegato" className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl animate-fade-in" />
                </div>
            )}
        </motion.div>
    );
}
