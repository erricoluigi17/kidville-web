import { ruoliDi, type AppUser, type StaffRole } from '@/lib/auth/predicati-ruolo'

const RUOLI_STORICI: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']

/** La veste attiva e il ponte genitore non concedono privilegi di stampa. */
export function firmaRuoliStorico(utente: AppUser): string {
  return [...new Set(ruoliDi(utente).filter(r => RUOLI_STORICI.some(a => a === r)))].sort().join(',')
}

/** I resolver legacy delle sedi ricevono il ruolo di lavoro, mai la veste del cookie. */
export function utenteStaffStorico(utente: AppUser): AppUser {
  const role = RUOLI_STORICI.find(r => ruoliDi(utente).includes(r))
  return role && role !== utente.role ? { ...utente, role } : utente
}
