'use client';

import { Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, ListTodo, CheckSquare, History, CheckCircle, Eye } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { TaskCard } from '@/components/features/teacher/tasks/TaskCard';
import { TaskForm } from '@/components/features/teacher/tasks/TaskForm';
import { TaskEditModal } from '@/components/features/teacher/tasks/TaskEditModal';
import { TaskResolutionModal } from '@/components/features/teacher/tasks/TaskResolutionModal';
import { useTasks, type TasksTab } from '@/components/features/teacher/tasks/useTasks';

function TeacherTasksContent() {
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

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Header verde (DR) */}
            <PageHeaderCard
                eyebrow="Strumenti staff"
                title="Attività"
                badge={pendingCount > 0 && activeTab !== 'archive' && (
                    <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-kidville-yellow px-2 font-barlow text-xs font-bold text-kidville-green">
                        {pendingCount}
                    </span>
                )}
                subtitle={
                    <span className="flex flex-wrap items-center gap-1.5">
                        <span>👤 {currentUserName}</span>
                        <span className="rounded-pill bg-white/15 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                            {userRole === 'admin' ? 'Direzione' : userRole === 'coordinator' ? 'Coordinatore' : 'Insegnante'}
                        </span>
                    </span>
                }
                action={
                    <Btn variant="secondary" size="sm" onClick={() => setShowCreateModal(true)}>
                        <Plus size={16} strokeWidth={1.8} /> Nuovo
                    </Btn>
                }
            />

            {/* Tabs — riga scrollabile orizzontalmente (affordance di scroll, niente troncamento) */}
            <div className="mt-5 mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-kidville-line bg-white p-1.5">
                {[
                    { key: 'assigned', icon: <ListTodo size={14} />, label: 'Assegnati a me' },
                    { key: 'created', icon: <CheckSquare size={14} />, label: 'Creati da me' },
                    ...(isManager ? [
                        { key: 'to_review', icon: <CheckCircle size={14} />, label: 'Da Controllare' },
                        { key: 'all', icon: <Eye size={14} />, label: 'Tutte le attività' }
                    ] : []),
                    { key: 'archive', icon: <History size={14} />, label: 'Archivio' }
                ].map(({ key, icon, label }) => (
                    <button
                        key={key}
                        onClick={() => setActiveTab(key as TasksTab)}
                        className={`shrink-0 whitespace-nowrap flex items-center justify-center gap-1.5 px-3 py-2.5 md:py-3 rounded-xl text-[10px] md:text-xs font-semibold uppercase tracking-wider font-barlow transition-all relative
                            ${activeTab === key
                                ? 'bg-white shadow text-kidville-green font-bold'
                                : 'text-kidville-muted hover:text-kidville-ink'}`}
                    >
                        {icon}
                        <span>{label}</span>
                        {key === 'to_review' && toReviewCount > 0 && (
                            <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-kidville-error text-white font-barlow font-bold text-[9px] animate-pulse">
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
                    <p className="font-maven text-sm text-kidville-muted">Caricamento attività...</p>
                </div>
            )}

            {/* Empty */}
            {!loading && tasks.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center bg-white rounded-3xl border border-dashed border-kidville-line p-8">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">
                        {activeTab === 'archive' ? '📂' : '✏️'}
                    </div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">
                        {activeTab === 'archive' ? 'Archivio vuoto' : 'Nessuna attività attiva'}
                    </h2>
                    <p className="font-maven text-kidville-muted text-sm max-w-xs leading-relaxed">
                        {activeTab === 'assigned' && 'Non hai attività in sospeso da svolgere al momento.'}
                        {activeTab === 'created' && 'Non hai creato alcuna attività per lo staff recentemente.'}
                        {activeTab === 'archive' && 'Non ci sono attività completate in archivio.'}
                    </p>
                </div>
            )}

            {/* Tasks List */}
            {!loading && teacherId && tasks.length > 0 && (
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
                            onComplete={openCompleteModal}
                            onDelete={handleDeleteTask}
                            onEdit={isManager ? (task) => setEditingTask(task) : undefined}
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
            <TeacherTasksContent />
        </Suspense>
    );
}
