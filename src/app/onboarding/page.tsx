import { redirect } from 'next/navigation'

// Il vecchio portale di pre-iscrizione è stato sostituito dal modulo pubblico
// `/iscrizione`, che archivia in `enrollment_submissions`. Della vecchia strada
// non resta niente: la sua tabella non esiste in produzione e la sua rotta —
// un POST anonimo che accettava codice fiscale e indirizzo del genitore più i
// dati dei figli — è stata cancellata il 2026-08-16. Il perché per esteso, e il
// lock che impedisce a entrambe di tornare, stanno nel lock d'architettura sui
// «residui delle due tabelle morte» (sotto `__tests__/architecture/`). I nomi
// esatti vivono solo là, ed è deliberato: quel lock li vieta sotto `src/`
// anche in prosa, perché il criterio resti verificabile a mano con una grep.
export default function OnboardingRedirect() {
  redirect('/iscrizione')
}
