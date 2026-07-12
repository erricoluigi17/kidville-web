/**
 * TEST reversibile (2026-07-12): con `true` tutti i PageHeaderCard (header di
 * pagina docente/genitore, in origine verdi) adottano lo stile del prototipo
 * "tab gialla app" — fondo giallo, testi verdi, mascotte a mezzo busto — per
 * provarlo su tutta l'app. Per tornare agli header verdi originali basta
 * rimettere `false`: la classe marker `.kv-tab-giallo` sparisce e il blocco
 * di remap in globals.css diventa inerte. Le home (HeroCard) restano gialle
 * a prescindere dal flag.
 */
export const TAB_GIALLO_OVUNQUE = true;
