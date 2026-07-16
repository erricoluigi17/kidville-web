'use client';

import { Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, ListTodo, CheckSquare, History, CheckCircle, Eye, ClipboardList } from 'lucide-react';
import { CockpitPage, HEADER_BTN, PageHeader, StatCard, Tabs, type TabOption } from '@/components/ui/cockpit';
import { TaskCard } from '@/components/features/teacher/tasks/TaskCard';
import { TaskForm } from '@/components/features/teacher/tasks/TaskForm';
import { TaskEditModal } from '@/components/features/teacher/tasks/TaskEditModal';
import { TaskResolutionModal } from '@/components/features/teacher/tasks/TaskResolutionModal';
import { useTasks, type TasksTab } from '@/components/features/teacher/tasks/useTasks';

// Attività/task interni dello staff nel cockpit (segreteria/direzione): stesso
// data-layer del docente (hook useTasks, endpoint /api/tasks*) con UI desktop.
// La pagina mobile /teacher/tasks è intoccata.

function AdminCompitiInner() {
  const t = useTasks();
  const {
    teacherId, tasks, loading, staff, students, classes, userRole, userClasses,
    activeTab, setActiveTab, toReviewCount, updatedTaskIds,
    isManager, pendingCount, currentUserName,
    showCreateModal, setShowCreateModal, editingTask, setEditingTask,
    resolvingTask, resolutionNotes, setResolutionNotes, resolvingFiles, setResolvingFiles, isSavingResolution,
    openCompleteModal, closeResolution, showToast, toastType,
    markTaskReadLocally, handleTakeCharge, handleConfirmResolution, handleCreateTask,
    handleSaveEdit, handleDeleteTask, handleResolveSubtask, handleUpdateSubtasks,
  } = t;

  const tabOptions: TabOption[] = [
    { id: 'assigned', label: 'Assegnati a me', icon: ListTodo },
    { id: 'created', label: 'Creati da me', icon: CheckSquare },
    ...(isManager ? [
      { id: 'to_review', label: 'Da controllare', icon: CheckCircle, count: toReviewCount || undefined },
      { id: 'all', label: 'Tutti i task', icon: Eye },
    ] as TabOption[] : []),
    { id: 'archive', label: 'Archivio', icon: History },
  ];

  return (
    <CockpitPage max={1200}>
      <PageHeader
        eyebrow="Comunicazione"
        icon={ClipboardList}
        title="Attività"
        subtitle={`Task interni dello staff · ${currentUserName}${userRole === 'admin' ? ' (Direzione)' : userRole === 'coordinator' ? ' (Coordinatore)' : ''}`}
        actions={
          <button
            onClick={() => setShowCreateModal(true)}
            className={HEADER_BTN}
          >
            <Plus size={16} strokeWidth={1.8} /> Nuovo task
          </button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-[560px]">
        <StatCard icon={ListTodo} label="Attività attive" value={loading ? '…' : pendingCount} />
        {isManager && (
          <StatCard icon={CheckCircle} label="Da controllare" value={loading ? '…' : toReviewCount} tone="yellow" />
        )}
      </div>

      <Tabs value={activeTab} options={tabOptions} onChange={(id) => setActiveTab(id as TasksTab)} />

      {loading ? (
        <div className="flex items-center gap-3 rounded-card bg-kidville-white p-6 shadow-sm">
          <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
          <p className="font-maven text-sm text-kidville-muted">Caricamento task…</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-card bg-kidville-white p-10 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-kidville-cream text-3xl">
            {activeTab === 'archive' ? '📂' : '✏️'}
          </div>
          <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">
            {activeTab === 'archive' ? 'Archivio vuoto' : 'Nessun task attivo'}
          </h2>
          <p className="font-maven mt-1 text-sm text-kidville-muted">
            {activeTab === 'assigned' && 'Non hai attività in sospeso da svolgere al momento.'}
            {activeTab === 'created' && 'Non hai creato alcun task per lo staff recentemente.'}
            {activeTab === 'to_review' && 'Nessun task in attesa di controllo.'}
            {activeTab === 'all' && 'Nessun task attivo nei tuoi plessi.'}
            {activeTab === 'archive' && 'Non ci sono task completati in archivio.'}
          </p>
        </div>
      ) : (
        teacherId && (
          <div className="mx-auto max-w-[720px] space-y-4">
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
                onComplete={openCompleteModal}
                onDelete={handleDeleteTask}
                onEdit={isManager ? (task) => setEditingTask(task) : undefined}
                onResolveSubtask={handleResolveSubtask}
                onUpdateSubtasks={handleUpdateSubtasks}
                onUpdateTaskFields={handleSaveEdit}
              />
            ))}
          </div>
        )
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
        {editingTask && teacherId && (
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
          <TaskResolutionModal
            task={resolvingTask}
            notes={resolutionNotes}
            onNotesChange={setResolutionNotes}
            files={resolvingFiles}
            onFilesChange={setResolvingFiles}
            isSaving={isSavingResolution}
            onConfirm={handleConfirmResolution}
            onClose={closeResolution}
          />
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {showToast && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className={`fixed top-6 left-1/2 -translate-x-1/2 z-[60] font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2 ${toastType === 'error' ? 'bg-kidville-error text-white' : 'bg-kidville-green text-white'}`}
          >
            {showToast}
          </motion.div>
        )}
      </AnimatePresence>
    </CockpitPage>
  );
}

export default function AdminCompitiPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <AdminCompitiInner />
    </Suspense>
  );
}
