import type { AppRole } from './predicati-ruolo'

/* ────────────────────────────────────────────────────────────────────────────
 * CHI PUÒ RIGENERARE LE CREDENZIALI DI CHI, detto in un posto solo.
 *
 * Lo consultano QUATTRO chiamanti: `admin/regenerate-credentials` (che fa il
 * reset), `admin/credentials-pdf` (che consegna il PDF con la password IN
 * CHIARO), e i due pannelli che mostrano o nascondono il pulsante. Se la regola
 * vivesse in due posti, il giorno in cui cambia ne cambierebbe uno solo — ed è
 * già successo in questo repo (vedi il lock `formula-sezione-un-posto-solo`).
 *
 * PERCHÉ LA DIREZIONE È UN'ECCEZIONE, e non è prudenza astratta. Dopo il reset
 * il PDF con la password in chiaro viene notificato a CHI HA PREMUTO IL
 * PULSANTE (`enqueueNotifiche` → `utenteIds: [auth.user.id]`), e
 * `admin/credentials-pdf` è aperta a tutto lo staff in scope di sede. Senza
 * questa riga una segreteria di Aversa resetterebbe l'admin di Aversa — che sta
 * nel suo STESSO plesso, misurato il 2026-09-03 — ne leggerebbe la password e vi
 * accederebbe. Non è un rischio ipotetico: è il percorso di consegna già in
 * esercizio.
 *
 * PERCHÉ LA MODIFICA DEL RUOLO RESTA ALLA DIREZIONE. Se la Segreteria potesse
 * cambiare il ruolo di un collega, promuoverebbe qualcuno ad `admin` e
 * otterrebbe per via indiretta ciò che questa funzione le nega. Le due riserve
 * si tengono in piedi a vicenda: togliendo l'altra, questa diventa decorativa.
 *
 * PERCHÉ È PURA E STA IN UN MODULO SUO. 296 file di test sostituiscono
 * `@/lib/auth/require-staff` per intero (`vi.mock(...)`): un predicato scritto lì
 * dentro verrebbe mockato via insieme all'I/O, e i test lo verificherebbero
 * finto. È la stessa ragione per cui esiste `predicati-ruolo.ts` — vedi la sua
 * testata, che quella lezione l'ha già pagata con 46 test su 7 file.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I ruoli che questi predicati riconoscono come bersaglio. Fuori da qui: si nega.
 *
 * L'elenco è scritto a mano e non derivato da `AppRole` di proposito: il
 * bersaglio arriva dal DATABASE come `string`, non come union type, e un ruolo
 * nuovo aggiunto alla colonna senza passare da qui deve essere NEGATO finché
 * qualcuno non decide cosa farne — non ammesso perché «è comunque uno staff».
 *
 * ESPORTATO dal 2026-09-04 perché lo usa anche `incarico-staff.ts`, che sta
 * accanto e risponde alla domanda gemella («chi può cambiare ruolo, gradi,
 * classi e sede di chi»). Le due riserve si tengono in piedi a vicenda, e il
 * vocabolario dei ruoli-bersaglio dev'essere lo STESSO: due copie divergono, e
 * la prima a divergere sarebbe quella che nessuno sta guardando.
 */
export const RUOLI_BERSAGLIO_NOTI = new Set<string>([
  'admin', 'coordinator', 'segreteria', 'educator', 'cuoca', 'genitore',
])

/** Gli account la cui password vale l'intero plesso: solo la Direzione li tocca. */
const DIREZIONE = new Set<string>(['admin', 'coordinator'])

export function puoRigenerareCredenzialiStaff(
  attore: AppRole,
  ruoloBersaglio: string | null | undefined,
): boolean {
  // Si nega ciò che non si è riusciti a leggere. Un `maybeSingle()` che torna
  // `null` — per assenza o per guasto — non deve mai diventare un permesso.
  if (!ruoloBersaglio || !RUOLI_BERSAGLIO_NOTI.has(ruoloBersaglio)) return false
  if (attore === 'admin' || attore === 'coordinator') return true
  if (attore === 'segreteria') return !DIREZIONE.has(ruoloBersaglio)
  return false
}
