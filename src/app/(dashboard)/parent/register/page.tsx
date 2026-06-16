import { redirect } from 'next/navigation';

// ⛔ DEPRECATA — vista "Registro" genitore legacy.
// Sostituita dalle pagine dedicate e conformi O.M. 3/2025 sotto /parent/primaria
// (valutazioni, note, pagelle, assenze) + /parent/compiti e /parent/lezioni.
// La rotta resta solo come redirect per non rompere notifiche/bookmark esistenti.
export default function DeprecatedParentRegisterPage() {
    redirect('/parent/primaria');
}
