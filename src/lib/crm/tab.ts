/**
 * CRM DELLA SEGRETERIA · LE CINQUE SCHEDE DELLA PAGINA `/admin/crm`.
 *
 * `?tab=` sceglie quella aperta. Sta in un file a sé, e non dentro `CrmShell`, perché sono dati puri:
 * li leggono la cornice, i test e — più avanti — i collegamenti che portano a una scheda precisa
 * (`/admin/crm?tab=richiamare`). Un file di componente che esporta anche costanti si rilegge male.
 *
 * «Scheda» qui è la linguetta della pagina; la scheda di una famiglia (`crm_schede`) è un'altra cosa.
 * Nel codice la linguetta si chiama `tab` per non confonderle.
 */
export const TAB_CRM = ['agenda', 'richiamare', 'schede', 'disponibilita', 'statistiche'] as const
export type TabCrm = (typeof TAB_CRM)[number]

export const TAB_PREDEFINITO: TabCrm = 'agenda'

/** La linguetta indicata da `?tab=`; ripiega sull'agenda per un valore assente o sconosciuto. */
export function tabDaParametro(valore: string | null | undefined): TabCrm {
  return (TAB_CRM as readonly string[]).includes(valore ?? '') ? (valore as TabCrm) : TAB_PREDEFINITO
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * La famiglia indicata da `?scheda=` (il collegamento che la lista «Quote dal CRM» della contabilità mette
 * accanto a ogni bambino: `/admin/crm?scheda=<schedaId>`). Solo un uuid passa, in minuscolo; qualunque altra
 * cosa — assente, vuota, con spazi, con un carattere in più — è `null` e si ignora. Un valore dell'indirizzo
 * entra in una richiesta (`/api/admin/crm/schede/<id>`) solo dopo essere stato riconosciuto qui.
 */
export function schedaDaParametro(valore: string | null | undefined): string | null {
  return typeof valore === 'string' && UUID.test(valore) ? valore.toLowerCase() : null
}
