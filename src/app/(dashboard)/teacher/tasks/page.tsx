'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, ListTodo, CheckSquare, History, X, CheckCircle, Paperclip, Eye } from 'lucide-react';
import { TaskCard, Task } from '@/components/features/teacher/tasks/TaskCard';
import { TaskForm, TaskFormData } from '@/components/features/teacher/tasks/TaskForm';
import { TaskEditModal } from '@/components/features/teacher/tasks/TaskEditModal';

interface StaffMember { id: string; first_name: string; last_name: string; role: string; }
interface StudentOption { id: string; nome: string; cognome: string; classe_sezione: string; }

function getTaskLastActivityTime(task: Task): number {
    let maxTime = new Date(task.created_at).getTime();

    if (task.resolved_at) {
        maxTime = Math.max(maxTime, new Date(task.resolved_at).getTime());
    }

    task.commenti?.forEach(c => {
        maxTime = Math.max(maxTime, new Date(c.created_at).getTime());
    });

    task.compiti?.forEach(sub => {
        if (sub.resolved_at) {
            maxTime = Math.max(maxTime, new Date(sub.resolved_at).getTime());
        }
        sub.commenti?.forEach(c => {
            maxTime = Math.max(maxTime, new Date(c.created_at).getTime());
        });
    });

    return maxTime;
}

function isLastActivityByCurrentUser(task: Task, currentUserId: string): boolean {
    let maxTime = new Date(task.created_at).getTime();
    let lastAuthorId = task.author_id;

    if (task.resolved_at) {
        const t = new Date(task.resolved_at).getTime();
        if (t > maxTime) {
            maxTime = t;
            lastAuthorId = task.resolved_by || '';
        }
    }

    task.commenti?.forEach(c => {
        const t = new Date(c.created_at).getTime();
        if (t > maxTime) {
            maxTime = t;
            lastAuthorId = c.author_id;
        }
    });

    task.compiti?.forEach(sub => {
        if (sub.resolved_at) {
            const t = new Date(sub.resolved_at).getTime();
            if (t > maxTime) {
                maxTime = t;
                lastAuthorId = sub.resolved_by || '';
            }
        }
        sub.commenti?.forEach(c => {
            const t = new Date(c.created_at).getTime();
            if (t > maxTime) {
                maxTime = t;
                lastAuthorId = c.author_id;
            }
        });
    });

    return lastAuthorId === currentUserId;
}

function TeacherTasksContent() {
    const searchParams = useSearchParams();
    const teacherId = searchParams.get('userId') || '22222222-2222-2222-2222-222222222222';

    const [activeTab, setActiveTab] = useState<'assigned' | 'created' | 'to_review' | 'all' | 'archive'>('assigned');
    const [toReviewCount, setToReviewCount] = useState(0);
    const [updatedTaskIds, setUpdatedTaskIds] = useState<string[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);

    const [staff, setStaff] = useState<StaffMember[]>([]);
    const [students, setStudents] = useState<StudentOption[]>([]);
    const [classes, setClasses] = useState<string[]>([]);
    const [userRole, setUserRole] = useState<string>('educator');
    const [userClasses, setUserClasses] = useState<string[]>([]);

    const [showCreateModal, setShowCreateModal] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [resolvingTask, setResolvingTask] = useState<Task | null>(null);
    const [resolutionNotes, setResolutionNotes] = useState('');
    const [resolvingFiles, setResolvingFiles] = useState<File[]>([]);
    const [isSavingResolution, setIsSavingResolution] = useState(false);

    const [showToast, setShowToast] = useState<string | null>(null);
    const [toastType, setToastType] = useState<'success' | 'error'>('success');

    // Ref to keep track of tasks from previous load for browser notifications
    const prevTasksRef = useRef<Task[]>([]);

    const markTaskReadLocally = useCallback((task: Task) => {
        if (typeof window === 'undefined') return;
        const actTime = getTaskLastActivityTime(task);
        const lastSeenStr = localStorage.getItem(`kidville_tasks_last_seen_${teacherId}`);
        const lastSeenMap = lastSeenStr ? JSON.parse(lastSeenStr) : {};
        lastSeenMap[task.id] = actTime;
        localStorage.setItem(`kidville_tasks_last_seen_${teacherId}`, JSON.stringify(lastSeenMap));
        setUpdatedTaskIds(prev => prev.filter(id => id !== task.id));
    }, [teacherId]);

    // Notification permissions
    useEffect(() => {
        if (typeof window !== 'undefined' && 'Notification' in window) {
            if (Notification.permission === 'default') {
                Notification.requestPermission();
            }
        }
    }, []);

    // Fetch user role and their classes (educator-sections returns both)
    const loadUserInfo = useCallback(async () => {
        try {
            const secRes = await fetch(`/api/educator-sections?userId=${teacherId}`);
            if (secRes.ok) {
                const secData = await secRes.json();
                setUserRole(secData.role || 'educator');
                setUserClasses(secData.sectionNames || []);
            }
        } catch (err) {
            console.error('Errore caricamento info utente:', err);
        }
    }, [teacherId]);

    const loadMetadata = useCallback(async () => {
        try {
            const metaRes = await fetch('/api/tasks/meta');
            if (metaRes.ok) {
                const meta = await metaRes.json();
                setStaff(meta.staff);
                setStudents(meta.students);
                setClasses(meta.classes);
            }
        } catch (err) {
            console.error('Errore caricamento metadata:', err);
        }
    }, []);

    // Helper to upload files to backend
    const uploadFiles = async (files: File[]) => {
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
                uploaded.push(data); // contains { fileUrl, name, size, type }
            } else {
                throw new Error(`Errore caricamento per il file: ${file.name}`);
            }
        }
        return uploaded;
    };

    const loadTasks = useCallback(async (showLoading = false) => {
        if (showLoading) setLoading(true);
        try {
            let url = `/api/tasks?userId=${teacherId}`;

            if (activeTab === 'assigned') {
                url += '&status=todo,in_progress,completed&filter=assigned';
            } else if (activeTab === 'created') {
                url += '&status=todo,in_progress,completed&filter=created';
            } else if (activeTab === 'to_review') {
                url += '&status=completed&filter=to_review';
            } else if (activeTab === 'all') {
                url += '&status=todo,in_progress,completed&filter=all';
            } else if (activeTab === 'archive') {
                url += '&status=approved';
            }

            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                
                // Determine updates based on activity timestamp comparison and localStorage
                const lastSeenStr = typeof window !== 'undefined' ? localStorage.getItem(`kidville_tasks_last_seen_${teacherId}`) : null;
                const lastSeenMap = lastSeenStr ? JSON.parse(lastSeenStr) : {};
                const newUpdates: string[] = [];
                const nextLastSeenMap = { ...lastSeenMap };

                data.forEach((newTask: Task) => {
                    const actTime = getTaskLastActivityTime(newTask);
                    const lastSeenTime = lastSeenMap[newTask.id];

                    if (lastSeenTime !== undefined) {
                        if (actTime > lastSeenTime) {
                            if (!isLastActivityByCurrentUser(newTask, teacherId)) {
                                newUpdates.push(newTask.id);
                            } else {
                                // Sync user's own action immediately
                                nextLastSeenMap[newTask.id] = actTime;
                            }
                        }
                    } else {
                        // First time seeing this task, initialize it as read
                        nextLastSeenMap[newTask.id] = actTime;
                    }
                });

                if (typeof window !== 'undefined') {
                    localStorage.setItem(`kidville_tasks_last_seen_${teacherId}`, JSON.stringify(nextLastSeenMap));
                }

                setUpdatedTaskIds(newUpdates);

                // If this is a polling update, check for browser notification triggers
                if (prevTasksRef.current.length > 0 && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
                    const prevMap = new Map(prevTasksRef.current.map(t => [t.id, t]));

                    data.forEach((newTask: Task) => {
                        const oldTask = prevMap.get(newTask.id);
                        if (!oldTask) {
                            // 1. New task assigned (direct or subtask)
                            const isAssigned = newTask.assignees?.includes(teacherId) || 
                                               newTask.compiti?.some(c => c.assigned_to === teacherId);
                            if (isAssigned && newTask.author_id !== teacherId) {
                                new Notification('Nuovo Task Kidville 📌', {
                                    body: `Ti è stato assegnato il task: "${newTask.titolo}"`,
                                    silent: false
                                });
                            }
                        } else {
                            // 2. Completed subtasks notification for task author
                            const isAuthor = newTask.author_id === teacherId;
                            if (isAuthor) {
                                newTask.compiti?.forEach(newSub => {
                                    const oldSub = oldTask.compiti?.find(os => os.id === newSub.id);
                                    if (oldSub && oldSub.status !== 'completed' && newSub.status === 'completed') {
                                        new Notification('Compito Risolto ✅', {
                                            body: `L'insegnante ha completato: "${newSub.titolo}"`,
                                            silent: false
                                        });
                                    }
                                });
                            }

                            // 3. Revision requested notification for assignee
                            newTask.compiti?.forEach(newSub => {
                                if (newSub.assigned_to === teacherId) {
                                    const oldSub = oldTask.compiti?.find(os => os.id === newSub.id);
                                    if (newSub.status === 'todo' && newSub.revision_feedback && 
                                        (!oldSub || oldSub.revision_feedback !== newSub.revision_feedback)) {
                                        new Notification('⚠️ Modifica Richiesta Task', {
                                            body: `Revisione per "${newSub.titolo}": ${newSub.revision_feedback}`,
                                            silent: false
                                        });
                                    }
                                }
                            });
                        }
                    });
                }
                
                prevTasksRef.current = data;
                setTasks(data);

                // Update count if current activeTab is to_review
                if (activeTab === 'to_review') {
                    setToReviewCount(data.length);
                }
            }

            // Fetch toReview count in the background for managers if not currently viewing it
            const isManager = userRole === 'admin' || userRole === 'coordinator';
            if (isManager && activeTab !== 'to_review') {
                const countRes = await fetch(`/api/tasks?userId=${teacherId}&status=completed&filter=to_review`);
                if (countRes.ok) {
                    const countData = await countRes.json();
                    setToReviewCount(countData.length);
                }
            }
        } catch (err) {
            console.error('Errore caricamento task:', err);
        } finally {
            if (showLoading) setLoading(false);
        }
    }, [teacherId, activeTab, userRole]);

    useEffect(() => { loadUserInfo(); loadMetadata(); }, [loadUserInfo, loadMetadata]);
    useEffect(() => { loadTasks(true); }, [loadTasks]);

    // Poll every 15s
    useEffect(() => {
        const interval = setInterval(() => loadTasks(false), 15000);
        return () => clearInterval(interval);
    }, [loadTasks]);

    const triggerToast = (msg: string, type: 'success' | 'error' = 'success') => {
        setShowToast(msg);
        setToastType(type);
        setTimeout(() => setShowToast(null), 3000);
    };

    // Take charge
    const handleTakeCharge = async (taskId: string) => {
        try {
            const res = await fetch(`/api/tasks/${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'in_progress' })
            });
            if (res.ok) {
                setTasks(prev => prev.map(t => {
                    if (t.id === taskId) {
                        const updated = { ...t, status: 'in_progress' as const };
                        markTaskReadLocally(updated);
                        return updated;
                    }
                    return t;
                }));
                triggerToast('Task preso in carico! ▶️');
            }
        } catch (err) { console.error(err); }
    };

    // Open completion modal
    const handleOpenCompleteModal = (task: Task) => {
        setResolvingTask(task);
        setResolutionNotes('');
        setResolvingFiles([]);
    };

    // Confirm task completion (with file upload support)
    const handleConfirmResolution = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!resolvingTask) return;
        setIsSavingResolution(true);
        try {
            let uploadedAttachments = [];
            if (resolvingFiles.length > 0) {
                uploadedAttachments = await uploadFiles(resolvingFiles);
            }

            const res = await fetch(`/api/tasks/${resolvingTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'completed',
                    resolution_notes: resolutionNotes,
                    resolved_by: teacherId,
                    attachments: uploadedAttachments,
                    revision_feedback: null // Clear task level feedback on submit
                })
            });
            if (res.ok) {
                setResolvingTask(null);
                setResolvingFiles([]);
                triggerToast('Task completato e archiviato! 🎉');
                await loadTasks(false);
            }
        } catch (err: any) { 
            alert(err.message || 'Errore durante la chiusura del task');
        }
        finally { setIsSavingResolution(false); }
    };

    // Create task
    const handleCreateTask = async (data: TaskFormData) => {
        try {
            const res = await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...data, author_id: teacherId })
            });
            if (res.ok) {
                triggerToast('Task creato e inviato! ✅');
                await loadTasks(false);
            } else {
                const err = await res.json();
                triggerToast(err.error || 'Errore nella creazione', 'error');
            }
        } catch (err) { console.error(err); }
    };

    // Edit task fields (managers only)
    const handleSaveEdit = async (taskId: string, updates: Record<string, unknown>, toastMessage?: string) => {
        const res = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        if (!res.ok) throw new Error('Errore salvataggio');
        triggerToast(toastMessage || 'Task aggiornato! ✏️');
        await loadTasks(false);
    };

    // Delete task
    const handleDeleteTask = async (taskId: string) => {
        if (!window.confirm('Eliminare definitivamente questo task?')) return;
        try {
            const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
            if (res.ok) {
                setTasks(prev => prev.filter(t => t.id !== taskId));
                triggerToast('Task eliminato.');
            }
        } catch (err) { console.error(err); }
    };

    // Resolve subtask (compito)
    const handleResolveSubtask = async (taskId: string, subtaskId: string, notes: string, attachments: any[] = []) => {
        const taskToUpdate = tasks.find(t => t.id === taskId);
        if (!taskToUpdate || !taskToUpdate.compiti) return;

        const updatedCompiti = taskToUpdate.compiti.map(c => {
            if (c.id === subtaskId) {
                return {
                    ...c,
                    status: 'completed' as const,
                    resolution_notes: notes,
                    resolved_by: teacherId,
                    resolved_at: new Date().toISOString(),
                    attachments: attachments,
                    revision_feedback: null // Clear revision feedback on resolve
                };
            }
            return c;
        });

        // The task is considered ready to be closed only if all subtasks are approved or completed
        const isAllCompleted = updatedCompiti.every(c => c.status === 'completed' || c.status === 'approved');
        const body: Record<string, unknown> = { compiti: updatedCompiti };
        
        if (isAllCompleted) {
            body.status = 'completed';
            body.resolution_notes = 'Tutti i compiti suddivisi sono stati completati.';
            body.resolved_by = teacherId;
        }

        const res = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res.ok) {
            triggerToast(isAllCompleted ? 'Tutti i compiti completati! 🎉' : 'Compito completato! ✅');
            await loadTasks(false);
        } else {
            const errData = await res.json();
            throw new Error(errData.error || 'Errore');
        }
    };

    // Generic subtasks update (comments, approvals, rejections)
    const handleUpdateSubtasks = async (taskId: string, updatedCompiti: any[], toastMessage?: string) => {
        const isAllCompleted = updatedCompiti.every(c => c.status === 'completed' || c.status === 'approved');
        const body: Record<string, unknown> = { compiti: updatedCompiti };
        
        if (isAllCompleted) {
            body.status = 'completed';
            body.resolution_notes = 'Tutti i compiti suddivisi sono stati completati e approvati.';
            body.resolved_by = teacherId;
        }

        const res = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res.ok) {
            triggerToast(toastMessage || (isAllCompleted ? 'Tutti i compiti approvati! 🎉' : 'Compiti aggiornati! ✅'));
            await loadTasks(false);
        } else {
            const errData = await res.json();
            throw new Error(errData.error || 'Errore nel salvataggio');
        }
    };

    const isManager = userRole === 'admin' || userRole === 'coordinator';
    const pendingCount = tasks.filter(t => t.status !== 'completed').length;
    
    const currentUserName = staff.find(s => s.id === teacherId) 
        ? `${staff.find(s => s.id === teacherId)!.first_name} ${staff.find(s => s.id === teacherId)!.last_name}` 
        : 'Insegnante';

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div className="text-left">
                    <div className="flex items-center gap-3">
                        <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                            📌 Task Staff
                        </h1>
                        {pendingCount > 0 && activeTab !== 'archive' && (
                            <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-orange-500 text-white font-barlow font-bold text-xs shadow-lg shadow-orange-500/20">
                                {pendingCount}
                            </span>
                        )}
                    </div>
                    <p className="font-maven text-gray-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>Comunicazioni organizzative e attività interne</span>
                        <span className="text-zinc-300">|</span>
                        <span className="font-bold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5 bg-zinc-100 dark:bg-zinc-800/60 px-2.5 py-0.5 rounded-full text-xs">
                            👤 {currentUserName}
                            <span className="text-[10px] bg-kidville-green/10 text-kidville-green px-2 py-0.5 rounded-full font-bold uppercase">
                                {userRole === 'admin' ? 'Direzione' : userRole === 'coordinator' ? 'Coordinatore' : 'Insegnante'}
                            </span>
                        </span>
                    </p>
                </div>
                <button
                    onClick={() => setShowCreateModal(true)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-kidville-green text-kidville-yellow font-barlow font-bold text-sm uppercase rounded-2xl hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-kidville-green/20"
                >
                    <Plus size={16} strokeWidth={1.5} /> Nuovo
                </button>
            </div>

            {/* Tabs */}
            <div className="flex flex-wrap md:flex-nowrap bg-zinc-100 dark:bg-zinc-900 p-1.5 gap-1 rounded-2xl mb-6 border border-gray-200/20">
                {[
                    { key: 'assigned', icon: <ListTodo size={14} />, label: 'Assegnati a me' },
                    { key: 'created', icon: <CheckSquare size={14} />, label: 'Creati da me' },
                    ...(isManager ? [
                        { key: 'to_review', icon: <CheckCircle size={14} />, label: 'Da Controllare' },
                        { key: 'all', icon: <Eye size={14} />, label: 'Tutti i Task' }
                    ] : []),
                    { key: 'archive', icon: <History size={14} />, label: 'Archivio' }
                ].map(({ key, icon, label }) => (
                    <button
                        key={key}
                        onClick={() => setActiveTab(key as any)}
                        className={`flex-1 min-w-[45%] md:min-w-0 flex items-center justify-center gap-1.5 py-2.5 md:py-3 rounded-xl text-[10px] md:text-xs font-semibold uppercase tracking-wider font-barlow transition-all relative
                            ${activeTab === key
                                ? 'bg-white dark:bg-zinc-800 shadow text-kidville-green dark:text-zinc-100 font-bold'
                                : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'}`}
                    >
                        {icon} 
                        <span>{label}</span>
                        {key === 'to_review' && toReviewCount > 0 && (
                            <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white font-barlow font-bold text-[9px] animate-pulse">
                                {toReviewCount}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-8 h-8 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-gray-400">Caricamento task...</p>
                </div>
            )}

            {/* Empty */}
            {!loading && tasks.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center bg-white/40 dark:bg-zinc-900/10 rounded-3xl border border-dashed border-gray-200 dark:border-zinc-800 p-8">
                    <div className="w-20 h-20 bg-kidville-cream dark:bg-zinc-900 rounded-full flex items-center justify-center mb-4 text-4xl">
                        {activeTab === 'archive' ? '📂' : '✏️'}
                    </div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green dark:text-zinc-200 uppercase mb-2">
                        {activeTab === 'archive' ? 'Archivio vuoto' : 'Nessun task attivo'}
                    </h2>
                    <p className="font-maven text-gray-400 text-sm max-w-xs leading-relaxed">
                        {activeTab === 'assigned' && 'Non hai attività in sospeso da svolgere al momento.'}
                        {activeTab === 'created' && 'Non hai creato alcun task per lo staff recentemente.'}
                        {activeTab === 'archive' && 'Non ci sono task completati in archivio.'}
                    </p>
                </div>
            )}

            {/* Tasks List */}
            {!loading && tasks.length > 0 && (
                <div className="space-y-4">
                    {tasks.map((task, idx) => (
                        <TaskCard
                            key={task.id}
                            task={task}
                            index={idx}
                            currentUserId={teacherId}
                            currentUserName={currentUserName}
                            currentUserRole={userRole}
                            isUpdated={updatedTaskIds.includes(task.id)}
                            onMarkRead={() => markTaskReadLocally(task)}
                            onTakeCharge={handleTakeCharge}
                            onComplete={handleOpenCompleteModal}
                            onDelete={handleDeleteTask}
                            onEdit={isManager ? (t) => setEditingTask(t) : undefined}
                            onResolveSubtask={handleResolveSubtask}
                            onUpdateSubtasks={handleUpdateSubtasks}
                            onUpdateTaskFields={handleSaveEdit}
                        />
                    ))}
                </div>
            )}

            {/* Create Task Modal */}
            <AnimatePresence>
                {showCreateModal && (
                    <TaskForm
                        open={showCreateModal}
                        onClose={() => setShowCreateModal(false)}
                        onSubmit={handleCreateTask}
                        staffMembers={staff}
                        students={students}
                        availableClasses={classes}
                        currentUserRole={userRole}
                        currentUserClasses={userClasses}
                    />
                )}
            </AnimatePresence>

            {/* Edit Task Modal (managers only) */}
            <AnimatePresence>
                {editingTask && (
                    <TaskEditModal
                        task={editingTask}
                        open={!!editingTask}
                        onClose={() => setEditingTask(null)}
                        onSave={async (taskId, updates) => handleSaveEdit(taskId, updates)}
                        staffMembers={staff}
                        currentUserId={teacherId}
                    />
                )}
            </AnimatePresence>

            {/* Task Completion Modal */}
            <AnimatePresence>
                {resolvingTask && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50"
                            onClick={() => setResolvingTask(null)}
                        />
                        <motion.div
                            initial={{ opacity: 0, y: 50, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 30, scale: 0.95 }}
                            className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-md bg-white dark:bg-zinc-950 rounded-3xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden border border-white/20 dark:border-zinc-800"
                        >
                            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-zinc-900">
                                <div className="flex items-center gap-2">
                                    <CheckCircle className="text-emerald-500" size={20} />
                                    <h2 className="font-barlow font-black text-lg text-kidville-green dark:text-zinc-50 uppercase tracking-wide">
                                        Risolvi Task
                                    </h2>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setResolvingTask(null)}
                                    className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-zinc-900 hover:bg-gray-200 dark:hover:bg-zinc-800 flex items-center justify-center text-gray-400 dark:text-zinc-500"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                            <form onSubmit={handleConfirmResolution} className="p-6 space-y-4 overflow-y-auto text-left">
                                <div>
                                    <p className="font-barlow font-bold text-sm text-kidville-green dark:text-zinc-300 uppercase tracking-wide">
                                        Task: {resolvingTask.titolo}
                                    </p>
                                    <p className="font-maven text-xs text-gray-400 mt-1">
                                        Per completare, spiega brevemente cosa hai fatto e come l&apos;hai risolto. Puoi allegare anche dei file.
                                    </p>
                                </div>

                                <div className="space-y-1">
                                    <label className="block text-xs font-bold text-kidville-green dark:text-zinc-400 uppercase tracking-wider mb-1">
                                        Note di Risoluzione *
                                    </label>
                                    <textarea
                                        required
                                        rows={3}
                                        placeholder="Spiega cosa hai fatto per risolvere il task..."
                                        value={resolutionNotes}
                                        onChange={e => setResolutionNotes(e.target.value)}
                                        className="w-full border-2 border-gray-200/60 dark:border-zinc-800 rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-green dark:text-zinc-200 bg-white/60 dark:bg-zinc-900/60 focus:outline-none focus:ring-2 focus:ring-kidville-green focus:border-transparent transition-all"
                                    />
                                </div>

                                {/* Uploader per il task principale */}
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-bold text-kidville-green dark:text-zinc-400 uppercase tracking-wider">
                                        Carica File / Allegati (Opzionale)
                                    </label>
                                    <div className="flex flex-wrap gap-2 items-center">
                                        <label className="flex items-center gap-1.5 px-3.5 py-2 border border-dashed border-gray-300 dark:border-zinc-700 hover:border-kidville-green hover:bg-zinc-50 rounded-2xl cursor-pointer font-maven text-xs text-zinc-500 hover:text-kidville-green transition-all uppercase font-semibold">
                                            <Paperclip size={13} /> Scegli file
                                            <input 
                                                type="file" 
                                                multiple 
                                                onChange={e => {
                                                    if (e.target.files) {
                                                        setResolvingFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                                                    }
                                                }} 
                                                className="hidden" 
                                                accept="image/*,.pdf,.doc,.docx"
                                            />
                                        </label>
                                        {resolvingFiles.map((file, fIdx) => (
                                            <span key={fIdx} className="inline-flex items-center gap-1 px-2.5 py-1 bg-zinc-100 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-850 rounded-xl text-[10px] text-zinc-600 dark:text-zinc-400 font-medium">
                                                {file.name.substring(0, 15)}... ({(file.size / 1024).toFixed(0)} KB)
                                                <button 
                                                    type="button" 
                                                    onClick={() => setResolvingFiles(prev => prev.filter((_, i) => i !== fIdx))}
                                                    className="text-red-500 hover:text-red-700 font-bold ml-1"
                                                >
                                                    ✕
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                </div>

                                <div className="flex gap-3 pt-2">
                                    <button
                                        type="button"
                                        onClick={() => setResolvingTask(null)}
                                        className="flex-1 py-3 border-2 border-gray-200 dark:border-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-900 rounded-2xl font-barlow font-black uppercase text-sm text-gray-500 tracking-wider transition-all"
                                    >
                                        Annulla
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={isSavingResolution}
                                        className="flex-1 py-3 bg-emerald-500 text-white hover:bg-emerald-600 rounded-2xl font-barlow font-black uppercase text-sm tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {isSavingResolution ? 'Salvataggio...' : 'Conferma Risolto'}
                                    </button>
                                </div>
                            </form>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* Toast */}
            <AnimatePresence>
                {showToast && (
                    <motion.div
                        initial={{ opacity: 0, y: -20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -10, scale: 0.95 }}
                        className={`fixed top-6 left-1/2 -translate-x-1/2 z-[60] font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2 ${toastType === 'error' ? 'bg-red-500 text-white' : 'bg-zinc-900 text-white'}`}
                    >
                        {showToast}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function TeacherTasksPage() {
    return (
        <Suspense fallback={
            <div className="max-w-2xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <TeacherTasksPageContent />
        </Suspense>
    );
}

function TeacherTasksPageContent() {
    return <TeacherTasksContent />;
}
