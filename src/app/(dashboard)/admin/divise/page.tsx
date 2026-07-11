import { redirect } from 'next/navigation';

// La sezione "Divise" è confluita in Merchandise (Fase B). Manteniamo la rotta
// come redirect per non rompere i link salvati.
export default function DivisePage() {
  redirect('/admin/merchandise');
}
