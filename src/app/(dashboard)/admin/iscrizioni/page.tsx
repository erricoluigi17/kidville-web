import { redirect } from 'next/navigation'

// La sezione "Iscrizioni" è stata unificata in "Modulistica" (tab "Moduli
// ricevuti"). Redirect per preservare link e segnalibri esistenti.
export default function IscrizioniRedirect() {
  redirect('/admin/modulistica?tab=ricevuti')
}
