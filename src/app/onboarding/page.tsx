import { redirect } from 'next/navigation'

// Il vecchio onboarding (pre_inscriptions) è stato sostituito dal nuovo
// form di iscrizione pubblico /iscrizione.
export default function OnboardingRedirect() {
  redirect('/iscrizione')
}
