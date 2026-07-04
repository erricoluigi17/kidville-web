'use client';

import type { FormEvent } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, X, Paperclip } from 'lucide-react';
import { Task } from '@/components/features/teacher/tasks/TaskCard';

// Modale "Risolvi Task" condivisa tra la pagina mobile del docente e il cockpit
// segreteria (/admin/compiti): stessa UI, note obbligatorie + allegati opzionali.

interface Props {
  task: Task;
  notes: string;
  onNotesChange: (v: string) => void;
  files: File[];
  onFilesChange: (updater: (prev: File[]) => File[]) => void;
  isSaving: boolean;
  onConfirm: (e: FormEvent) => void | Promise<void>;
  onClose: () => void;
}

export function TaskResolutionModal({ task, notes, onNotesChange, files, onFilesChange, isSaving, onConfirm, onClose }: Props) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, y: 50, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 30, scale: 0.95 }}
        className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-md bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden border border-white/20"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-kidville-line">
          <div className="flex items-center gap-2">
            <CheckCircle className="text-kidville-success" size={20} />
            <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">
              Risolvi Task
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-kidville-cream hover:bg-kidville-cream-dark flex items-center justify-center text-kidville-muted"
          >
            <X size={14} />
          </button>
        </div>
        <form onSubmit={onConfirm} className="p-6 space-y-4 overflow-y-auto text-left">
          <div>
            <p className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide">
              Task: {task.titolo}
            </p>
            <p className="font-maven text-xs text-kidville-muted mt-1">
              Per completare, spiega brevemente cosa hai fatto e come l&apos;hai risolto. Puoi allegare anche dei file.
            </p>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider mb-1">
              Note di Risoluzione *
            </label>
            <textarea
              required
              rows={3}
              placeholder="Spiega cosa hai fatto per risolvere il task..."
              value={notes}
              onChange={e => onNotesChange(e.target.value)}
              className="w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green focus:border-transparent transition-all"
            />
          </div>

          {/* Uploader per il task principale */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-kidville-green uppercase tracking-wider">
              Carica File / Allegati (Opzionale)
            </label>
            <div className="flex flex-wrap gap-2 items-center">
              <label className="flex items-center gap-1.5 px-3.5 py-2 border border-dashed border-kidville-line hover:border-kidville-green hover:bg-kidville-cream rounded-2xl cursor-pointer font-maven text-xs text-kidville-muted hover:text-kidville-green transition-all uppercase font-semibold">
                <Paperclip size={13} /> Scegli file
                <input
                  type="file"
                  multiple
                  onChange={e => {
                    if (e.target.files) {
                      const picked = Array.from(e.target.files);
                      onFilesChange(prev => [...prev, ...picked]);
                    }
                  }}
                  className="hidden"
                  accept="image/*,.pdf,.doc,.docx"
                />
              </label>
              {files.map((file, fIdx) => (
                <span key={fIdx} className="inline-flex items-center gap-1 px-2.5 py-1 bg-kidville-cream border border-kidville-line rounded-xl text-[10px] text-kidville-ink font-medium">
                  {file.name.substring(0, 15)}... ({(file.size / 1024).toFixed(0)} KB)
                  <button
                    type="button"
                    onClick={() => onFilesChange(prev => prev.filter((_, i) => i !== fIdx))}
                    className="text-kidville-error hover:text-kidville-error font-bold ml-1"
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
              onClick={onClose}
              className="flex-1 py-3 border-2 border-kidville-line hover:bg-kidville-cream rounded-2xl font-barlow font-black uppercase text-sm text-kidville-muted tracking-wider transition-all"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 py-3 bg-kidville-success text-white hover:opacity-90 rounded-2xl font-barlow font-black uppercase text-sm tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSaving ? 'Salvataggio...' : 'Conferma Risolto'}
            </button>
          </div>
        </form>
      </motion.div>
    </>
  );
}
