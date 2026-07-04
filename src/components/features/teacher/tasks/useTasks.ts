'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { FormEvent } from 'react';
import { Task } from '@/components/features/teacher/tasks/TaskCard';
import { TaskFormData } from '@/components/features/teacher/tasks/TaskForm';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// =============================================================================
// Data-layer condiviso delle Attività (task staff): stato, fetch, polling,
// notifiche browser e handler. Usato dalla pagina mobile del docente
// (/teacher/tasks) e dal cockpit segreteria (/admin/compiti): stessi endpoint
// /api/tasks*, stessa logica, UI diversa. Estratto per evitare il fork da 700
// righe (le due pagine differiscono solo per header/tab/empty-state).
// =============================================================================

export interface StaffMember { id: string; first_name: string; last_name: string; role: string }
export interface StudentOption { id: string; nome: string; cognome: string; classe_sezione: string }

export type TasksTab = 'assigned' | 'created' | 'to_review' | 'all' | 'archive';

export function getTaskLastActivityTime(task: Task): number {
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

export function useTasks() {
  const { userId: teacherId } = useSessionIdentity();

  const [activeTab, setActiveTab] = useState<TasksTab>('assigned');
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
    if (typeof window === 'undefined' || !teacherId) return;
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
    if (!teacherId) return; // identità non risolta: niente fetch
    try {
      const secRes = await fetch(`/api/educator-sections?userId=${teacherId}`).catch(() => null);
      if (secRes?.ok) {
        const secData = await secRes.json().catch(() => null);
        if (secData) {
          setUserRole(secData.role || 'educator');
          setUserClasses(secData.sectionNames || []);
        }
      }
    } finally { /* niente cleanup: pattern try/finally per react-hooks 7 */ }
  }, [teacherId]);

  const loadMetadata = useCallback(async () => {
    if (!teacherId) return;
    try {
      const metaRes = await fetch(`/api/tasks/meta?userId=${teacherId}`).catch(() => null);
      if (metaRes?.ok) {
        const meta = await metaRes.json().catch(() => null);
        if (meta) {
          setStaff(meta.staff);
          setStudents(meta.students);
          setClasses(meta.classes);
        }
      }
    } finally { /* niente cleanup: pattern try/finally per react-hooks 7 */ }
  }, [teacherId]);

  // Helper to upload files to backend
  const uploadFiles = useCallback(async (files: File[]) => {
    const uploaded: Array<{ fileUrl: string; name: string; size: number; type: string }> = [];
    if (!teacherId) return uploaded;
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/tasks/upload?userId=${teacherId}`, {
        method: 'POST',
        headers: { 'x-user-id': teacherId },
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
  }, [teacherId]);

  const loadTasks = useCallback(async (showLoading = false) => {
    if (!teacherId) return; // identità non risolta: lo spinner iniziale resta attivo
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

      const res = await fetch(url).catch(() => null);
      const data: Task[] | null = res?.ok ? await res.json().catch(() => null) : null;
      if (data) {

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
        const countRes = await fetch(`/api/tasks?userId=${teacherId}&status=completed&filter=to_review`).catch(() => null);
        if (countRes?.ok) {
          const countData = await countRes.json().catch(() => null);
          if (countData) setToReviewCount(countData.length);
        }
      }
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

  const triggerToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setShowToast(msg);
    setToastType(type);
    setTimeout(() => setShowToast(null), 3000);
  }, []);

  // Take charge
  const handleTakeCharge = useCallback(async (taskId: string) => {
    if (!teacherId) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}?userId=${teacherId}`, {
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
  }, [teacherId, markTaskReadLocally, triggerToast]);

  // Open completion modal
  const handleOpenCompleteModal = useCallback((task: Task) => {
    setResolvingTask(task);
    setResolutionNotes('');
    setResolvingFiles([]);
  }, []);

  const closeResolution = useCallback(() => {
    setResolvingTask(null);
    setResolvingFiles([]);
  }, []);

  // Confirm task completion (with file upload support)
  const handleConfirmResolution = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!resolvingTask || !teacherId) return;
    setIsSavingResolution(true);
    try {
      let uploadedAttachments: Array<{ fileUrl: string; name: string; size: number; type: string }> = [];
      if (resolvingFiles.length > 0) {
        uploadedAttachments = await uploadFiles(resolvingFiles);
      }

      const res = await fetch(`/api/tasks/${resolvingTask.id}?userId=${teacherId}`, {
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
    } catch (err) {
      alert(err instanceof Error && err.message ? err.message : 'Errore durante la chiusura del task');
    }
    finally { setIsSavingResolution(false); }
  }, [resolvingTask, teacherId, resolvingFiles, resolutionNotes, uploadFiles, triggerToast, loadTasks]);

  // Create task
  const handleCreateTask = useCallback(async (data: TaskFormData) => {
    if (!teacherId) return;
    try {
      const res = await fetch(`/api/tasks?userId=${teacherId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
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
  }, [teacherId, triggerToast, loadTasks]);

  // Edit task fields (managers only)
  const handleSaveEdit = useCallback(async (taskId: string, updates: Record<string, unknown>, toastMessage?: string) => {
    if (!teacherId) return;
    const res = await fetch(`/api/tasks/${taskId}?userId=${teacherId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error('Errore salvataggio');
    triggerToast(toastMessage || 'Task aggiornato! ✏️');
    await loadTasks(false);
  }, [teacherId, triggerToast, loadTasks]);

  // Delete task
  const handleDeleteTask = useCallback(async (taskId: string) => {
    if (!teacherId) return;
    if (!window.confirm('Eliminare definitivamente questo task?')) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}?userId=${teacherId}`, { method: 'DELETE' });
      if (res.ok) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
        triggerToast('Task eliminato.');
      }
    } catch (err) { console.error(err); }
  }, [teacherId, triggerToast]);

  // Resolve subtask (compito)
  const handleResolveSubtask = useCallback(async (taskId: string, subtaskId: string, notes: string, attachments: NonNullable<Task['attachments']> = []) => {
    if (!teacherId) return;
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

    const res = await fetch(`/api/tasks/${taskId}?userId=${teacherId}`, {
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
  }, [teacherId, tasks, triggerToast, loadTasks]);

  // Generic subtasks update (comments, approvals, rejections)
  const handleUpdateSubtasks = useCallback(async (taskId: string, updatedCompiti: NonNullable<Task['compiti']>, toastMessage?: string) => {
    if (!teacherId) return;
    const isAllCompleted = updatedCompiti.every(c => c.status === 'completed' || c.status === 'approved');
    const body: Record<string, unknown> = { compiti: updatedCompiti };

    if (isAllCompleted) {
      body.status = 'completed';
      body.resolution_notes = 'Tutti i compiti suddivisi sono stati completati e approvati.';
      body.resolved_by = teacherId;
    }

    const res = await fetch(`/api/tasks/${taskId}?userId=${teacherId}`, {
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
  }, [teacherId, triggerToast, loadTasks]);

  const isManager = userRole === 'admin' || userRole === 'coordinator';
  const pendingCount = tasks.filter(t => t.status !== 'completed').length;

  const currentUserName = staff.find(s => s.id === teacherId)
    ? `${staff.find(s => s.id === teacherId)!.first_name} ${staff.find(s => s.id === teacherId)!.last_name}`
    : 'Insegnante';

  return {
    teacherId,
    // liste + stato
    tasks, loading,
    staff, students, classes, userRole, userClasses,
    activeTab, setActiveTab,
    toReviewCount, updatedTaskIds,
    isManager, pendingCount, currentUserName,
    // modali
    showCreateModal, setShowCreateModal,
    editingTask, setEditingTask,
    resolvingTask, resolutionNotes, setResolutionNotes,
    resolvingFiles, setResolvingFiles, isSavingResolution,
    openCompleteModal: handleOpenCompleteModal,
    closeResolution,
    // toast
    showToast, toastType,
    // handler
    markTaskReadLocally,
    handleTakeCharge,
    handleConfirmResolution,
    handleCreateTask,
    handleSaveEdit,
    handleDeleteTask,
    handleResolveSubtask,
    handleUpdateSubtasks,
  };
}

export type UseTasks = ReturnType<typeof useTasks>;
