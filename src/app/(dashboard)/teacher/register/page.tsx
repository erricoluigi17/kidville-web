import { redirect } from 'next/navigation';

// ⛔ DEPRECATA — Registro di Classe primaria "legacy".
// Esponeva voti numerici visibili (1-10) e la scala Base/Intermedio/Avanzato,
// NON conformi alla L. 150/2024 e O.M. 3/2025. È sostituita dalle pagine
// /teacher/primaria/[sectionId]/* (registro, valutazioni, prospetto, note, scrutinio)
// basate sui giudizi sintetici dell'Allegato A. Vedi PRD §4 e Appendice.
// La rotta resta solo come redirect per non rompere link/bookmark esistenti.
export default function DeprecatedTeacherRegisterPage() {
    redirect('/teacher/primaria');
}
