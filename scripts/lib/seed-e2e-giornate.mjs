/** Piano puro: nessuna configurazione, credenziale o connessione al database. */
export function pianoGiorniSeedE2E(ora, ids, piatti) {
  const oggi = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(ora);
  // Si avanza nel calendario civile già risolto a Roma, non di 24 ore sull'istante:
  // i giorni del cambio d'ora durano 23 o 25 ore.
  const successivo = new Date(`${oggi}T12:00:00Z`);
  successivo.setUTCDate(successivo.getUTCDate() + 1);
  const giorni = [oggi, successivo.toISOString().slice(0, 10)];
  return {
    giorni,
    // Girasoli resta senza appello: ogni giorno conserva 1 presente su 5 alunni.
    presenze: giorni.flatMap((data) => [
      { alunno_id: ids.A3, data, stato: 'presente', orario_entrata: '08:45', scuola_id: ids.SCUOLA, section_id: ids.SEC_TULIPANI },
      { alunno_id: ids.A4, data, stato: 'assente', scuola_id: ids.SCUOLA, section_id: ids.SEC_TULIPANI },
    ]),
    menu: giorni.flatMap((data, indice) => [
      {
        id: indice === 0 ? ids.MENU_OVR_S1 : ids.MENU_OVR_S1_DOMANI,
        scuola_id: ids.SCUOLA, data, chiuso: false, menu_config_id: null,
        portate: { primo: piatti.primoSede1, secondo: 'Frittata E2E', contorno: 'Insalata E2E', frutta: 'Mela E2E' },
        note: 'Menu E2E della sede 1',
      },
      {
        id: indice === 0 ? ids.MENU_OVR_S2 : ids.MENU_OVR_S2_DOMANI,
        scuola_id: ids.SCUOLA2, data, chiuso: false, menu_config_id: null,
        portate: { primo: piatti.primoSede2, secondo: 'Platessa E2E', contorno: 'Carote E2E', frutta: 'Pera E2E' },
        note: 'Menu E2E della sede 2',
      },
    ]),
  };
}
