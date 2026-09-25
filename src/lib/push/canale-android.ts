/**
 * Il canale Android delle notifiche Kidville: UN nome solo, per il server e per il client.
 *
 * Il server lo scrive in `android.notification.channel_id` di ogni push (`native-push.ts`); il
 * client lo CREA all'avvio («Notifiche Kidville», importanza alta, contenuto visibile). I due
 * devono coincidere carattere per carattere: se il server nomina un canale che il telefono non
 * ha, Android non scarta la notifica ma la fa ripiegare sul canale di riserva
 * («Miscellaneous»), cioè il difetto di partenza — silenzioso, senza un errore da nessuna parte.
 *
 * File senza dipendenze apposta: `native-push.ts` importa `node:crypto` e non può finire nel
 * bundle del client, questa costante sì.
 */
export const CANALE_ANDROID_NOTIFICHE = 'kidville_notifiche'
