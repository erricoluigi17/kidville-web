'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Baby, BookOpen } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { useTeacherGradi } from '@/lib/auth/use-teacher-gradi';

// Switch tra i "mondi" Infanzia/Nido e Primaria per i docenti misti.
// Compare solo se il docente è abilitato a più di un grado (gradi via
// useTeacherGradi: fetch condiviso con TeacherBottomNav e home).
export function GradeWorldSwitch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const userId = getCurrentTeacherId(params);
  const { hasInfanzia, hasPrimaria } = useTeacherGradi(userId);
  if (!(hasInfanzia && hasPrimaria)) return null;

  const inPrimaria = pathname?.startsWith('/teacher/primaria');
  const suffix = `?userId=${userId}`;

  return (
    <div className="inline-flex rounded-pill bg-white p-1 shadow-sm">
      <button
        onClick={() => router.push(`/teacher${suffix}`)}
        className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm transition ${
          !inPrimaria ? 'bg-kidville-green text-kidville-yellow' : 'text-kidville-muted'
        }`}
      >
        <Baby size={14} /> Infanzia
      </button>
      <button
        onClick={() => router.push(`/teacher/primaria${suffix}`)}
        className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm transition ${
          inPrimaria ? 'bg-kidville-green text-kidville-yellow' : 'text-kidville-muted'
        }`}
      >
        <BookOpen size={14} /> Primaria
      </button>
    </div>
  );
}
