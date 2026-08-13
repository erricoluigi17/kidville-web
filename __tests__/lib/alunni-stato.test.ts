import { describe, it, expect } from 'vitest'
import {
  STATO_ISCRITTO,
  STATO_RITIRATO,
  STATO_SOSPESO,
  STATI_TENDINA,
  STATI_NON_PIU_ISCRITTO,
  LATO_DEL_CONFINE,
  eNonPiuIscritto,
  eAncoraIscritto,
} from '@/lib/alunni/stato'

/**
 * Il confine fra «iscritto» e «non più iscritto» sta in un posto solo, e questo
 * file lo tiene fermo. Non è un test di comodo: dal valore di `eNonPiuIscritto`
 * dipende chi finisce nell'elenco dei candidati all'anonimizzazione — che è
 * l'unica operazione dell'applicazione senza un annulla.
 *
 * ⚠️ Da solo NON basta, e fino al 2026-08-12 il modulo diceva il contrario: la
 * tendina che scrive `alunni.stato` sta in un `.tsx` che questo file non vede.
 * A guardare quella c'è `__tests__/architecture/stati-alunno-classificati.test.ts`.
 * I due insieme chiudono il giro; ognuno da solo lascia una porta aperta.
 */
describe('alunni/stato — il confine di «non più iscritto»', () => {
  it('è un ELENCO di stati ammessi, non una negazione', () => {
    // Una negazione (`!== 'iscritto'`) accoglie ogni valore futuro senza che
    // nessuno lo decida. Un elenco costringe a deciderlo.
    expect([...STATI_NON_PIU_ISCRITTO]).toEqual(['ritirato'])
    expect(STATO_ISCRITTO).toBe('iscritto')
    expect(STATO_RITIRATO).toBe('ritirato')
    expect(STATO_SOSPESO).toBe('sospeso')
  })

  // ⬇︎ IL TEST CHE IL MODULO PROMETTEVA E NON AVEVA.
  // Il giorno che qualcuno aggiunge una voce alla tendina, il lock architetturale
  // pretende che compaia in `STATI_TENDINA`; e appena compare lì, `tsc` chiede
  // una riga in `LATO_DEL_CONFINE` — cioè una DECISIONE. Queste due righe
  // ridicono la stessa cosa a runtime, perché un lock che vive solo nei tipi si
  // spegne con un `as` o un `any`.
  it('la decisione copre esattamente gli stati che la tendina offre', () => {
    expect(
      Object.keys(LATO_DEL_CONFINE).sort(),
      'Uno stato della tendina non ha una riga in `LATO_DEL_CONFINE` (o viceversa): ' +
      'decidi di che parte del confine sta. Un bambino con uno stato non deciso non ' +
      'compare fra i candidati all\'oblio e viene rifiutato da `gdpr/erase` — cioè ' +
      'non è più cancellabile da nessuna parte.',
    ).toEqual([...STATI_TENDINA].sort())
  })

  it('la decisione e il predicato non possono divergere', () => {
    // `STATI_NON_PIU_ISCRITTO` DERIVA da `LATO_DEL_CONFINE`: se un giorno
    // tornasse a essere un elenco scritto a mano, questa riga se ne accorge.
    for (const s of STATI_TENDINA) {
      expect(eNonPiuIscritto(s), `stato «${s}»`).toBe(LATO_DEL_CONFINE[s] === 'non-piu-iscritto')
      expect(eAncoraIscritto(s), `stato «${s}»`).toBe(LATO_DEL_CONFINE[s] === 'ancora-iscritto')
    }
  })

  it('«ritirato» non è più iscritto', () => {
    expect(eNonPiuIscritto(STATO_RITIRATO)).toBe(true)
    expect(eAncoraIscritto(STATO_RITIRATO)).toBe(false)
  })

  it('«iscritto» è ancora iscritto', () => {
    expect(eNonPiuIscritto(STATO_ISCRITTO)).toBe(false)
    expect(eAncoraIscritto(STATO_ISCRITTO)).toBe(true)
  })

  // ⬇︎ IL DIFETTO CHE QUESTO MODULO CHIUDE.
  // La tendina dello stato (StudentDetailPanel) offre TRE valori: iscritto,
  // ritirato, sospeso. Con `stato !== 'iscritto'` un bambino soltanto SOSPESO —
  // che è iscritto a tutti gli effetti — entrava fra i candidati all'oblio.
  it('«sospeso» è ancora iscritto: è un bambino a scuola, e non si anonimizza', () => {
    expect(eNonPiuIscritto(STATO_SOSPESO)).toBe(false)
    expect(eAncoraIscritto(STATO_SOSPESO)).toBe(true)
  })

  it('uno stato mai visto prima NON autorizza nulla di irreversibile', () => {
    // `alunni.stato` è varchar SENZA vincolo CHECK e la PATCH admin la valida
    // con `z.unknown()`: qualunque stringa può finire nella colonna. Un elenco
    // chiuso è l'unica cosa che impedisce a un refuso di diventare un oblio.
    expect(eNonPiuIscritto('non_iscritto')).toBe(false)
    expect(eNonPiuIscritto('trasferito')).toBe(false)
    expect(eNonPiuIscritto('Ritirato')).toBe(false) // maiuscola: stringa diversa
    expect(eNonPiuIscritto('ritirato ')).toBe(false) // spazio in coda: stringa diversa
    expect(eNonPiuIscritto('')).toBe(false)
  })

  it('lo stato assente vale iscritto, non ritirato', () => {
    // La colonna è NULLABLE con default 'iscritto'. Un vuoto è un'informazione
    // che manca, e ciò che manca non può autorizzare una cancellazione.
    expect(eNonPiuIscritto(null)).toBe(false)
    expect(eNonPiuIscritto(undefined)).toBe(false)
    expect(eAncoraIscritto(null)).toBe(true)
    expect(eAncoraIscritto(undefined)).toBe(true)
  })

  it('i due predicati sono complementari: un solo confine, non due', () => {
    // Se `eAncoraIscritto` fosse `stato === 'iscritto'` esisterebbe una terra di
    // mezzo (sospeso, e ogni stato futuro) su cui ogni chiamante deciderebbe da
    // capo — cioè esattamente il difetto, spostato di un metro.
    for (const s of ['iscritto', 'ritirato', 'sospeso', 'boh', '', null, undefined]) {
      expect(eAncoraIscritto(s)).toBe(!eNonPiuIscritto(s))
    }
  })

  // ⬇︎ PERCHÉ `archiviato_il` NON ENTRA IN QUESTA DECISIONE.
  // La migrazione `20260812194517_alunni_archiviazione` ha aggiunto la colonna, e
  // la tentazione è farla autorizzare insieme allo stato («è archiviato, quindi
  // si può anonimizzare»). Sarebbe un secondo confine, e nel verso sbagliato: il
  // RITORNO fra gli iscritti riporta `stato` a `'iscritto'` per forza — altrimenti
  // il bambino non ricompare da nessuna parte e la segreteria se ne accorge lo
  // stesso giorno — mentre azzerare `archiviato_il` è la riga che si dimentica.
  // Un `archiviato_il` stantio su un bambino che frequenta lo metterebbe
  // nell'elenco dell'anonimizzazione irreversibile. Il campo che sopravvive a un
  // errore umano non può essere quello che autorizza.
  it('lo stato «iscritto» non autorizza nulla, comunque sia stato archiviato in passato', () => {
    expect(eNonPiuIscritto(STATO_ISCRITTO)).toBe(false)
    expect(eAncoraIscritto(STATO_ISCRITTO)).toBe(true)
  })
})
