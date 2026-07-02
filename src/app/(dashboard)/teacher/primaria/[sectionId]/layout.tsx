import { ClasseShell } from '@/components/features/primaria/ClasseShell';

// La cornice per-classe è il componente condiviso ClasseShell. Qui il prefisso
// di base è quello del flusso docente; il cockpit Direzione/Segreteria usa lo
// stesso componente con basePrefix="/admin/primaria".
export default function PrimariaClasseLayout({ children }: { children: React.ReactNode }) {
  return <ClasseShell basePrefix="/teacher/primaria">{children}</ClasseShell>;
}
