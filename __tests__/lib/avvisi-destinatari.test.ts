import { describe, it, expect } from 'vitest'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import { etichettaDestinatario, type ClasseNota } from '@/lib/avvisi/destinatari'

// =============================================================================
// `target_classes` è un campo ETEROGENEO, e questa è la coda dell'audit multi-sede.
//
// Il collaudo iOS del 2026-07-31 (F4) ha fotografato due card su cinque, nella
// bacheca del docente, con come destinatario `219cab6a-…` — l'ID della sezione
// «TEST Infanzia» stampato tale e quale. Gli STESSI avvisi, nel cockpit, dicono
// «TEST Infanzia»: due letture diverse dello stesso campo.
//
// La causa non è un errore di battitura: finché il plesso era uno, il NOME della
// classe era di fatto una chiave, e chi scriveva l'id o chi scriveva il nome
// produceva un dato ugualmente leggibile. Con tre sedi «2 ANNI» esiste ad Aversa
// e a Cesa: il nome non identifica più niente, l'id sì — e chi legge deve saper
// leggere ENTRAMBE le forme senza mai mostrare l'uuid a un genitore.
//
// METODO. Ogni asserzione negativa («non contiene l'uuid») ha accanto il suo
// controllo positivo («contiene il nome giusto»): un'implementazione che
// restituisse sempre stringa vuota passerebbe la prima e cadrebbe sulla seconda.
// =============================================================================

const UUID_SEZIONE = '11111111-2222-4333-8444-555555555555'

/** Due sedi con un nome di classe in comune: è il caso vero dal 2026-07-29. */
const CLASSI: ClasseNota[] = [
    { id: UUID_SEZIONE, nome: 'TEST Infanzia', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-b-2anni', nome: '2 ANNI', scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B },
    { id: 'sez-b-primavera', nome: 'PRIMAVERA', scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B },
]

/** Le sole classi della sede A: l'elenco che vede un docente di una sede sola. */
const CLASSI_UNA_SEDE = CLASSI.filter((c) => c.scuolaId === SEDE_A)

describe('etichettaDestinatario — l\'identità di una classe destinataria', () => {
    it('risolve l\'ID di sezione nel NOME della classe (difetto iOS F4)', () => {
        const e = etichettaDestinatario(UUID_SEZIONE, CLASSI_UNA_SEDE)

        // La mutazione che conta: il testo reso NON è più l'uuid, ed è il nome vero.
        expect(e.risolta).toBe(true)
        expect(e.risolta && e.testo).toBe('TEST Infanzia')
        // Controllo negativo, che senza quello positivo qui sopra non varrebbe nulla.
        expect(e.risolta && e.testo).not.toContain(UUID_SEZIONE)
    })

    it('con più sedi in gioco l\'etichetta dice ANCHE il plesso', () => {
        const e = etichettaDestinatario(UUID_SEZIONE, CLASSI)

        expect(e.risolta && e.testo).toBe(`TEST Infanzia — ${NOME_SEDE_A}`)
    })

    it('un NOME di classe resta il nome (è la forma che scrive il modulo)', () => {
        const e = etichettaDestinatario('PRIMAVERA', CLASSI)

        expect(e.risolta).toBe(true)
        expect(e.risolta && e.testo).toBe(`PRIMAVERA — ${NOME_SEDE_B}`)
    })

    it('un nome OMONIMO in due sedi non viene attribuito a una delle due', () => {
        // «2 ANNI» esiste in A e in B: aggiungere una sede sarebbe indovinare, cioè
        // l'errore che questo audit sta chiudendo. Il nome è tutto ciò che si sa.
        const e = etichettaDestinatario('2 ANNI', CLASSI)

        expect(e.risolta && e.testo).toBe('2 ANNI')
        expect(e.risolta && e.testo).not.toContain(NOME_SEDE_A)
        expect(e.risolta && e.testo).not.toContain(NOME_SEDE_B)
    })

    it('un uuid NON risolvibile non si stampa: si dichiara sconosciuto', () => {
        // Il caso del genitore, che non ha nessun elenco di sezioni, e il caso di
        // una sezione cancellata. In entrambi mostrare l'uuid è il difetto.
        const ignoto = etichettaDestinatario(UUID_SEZIONE, [])
        expect(ignoto.risolta).toBe(false)

        // Controllo positivo accanto: con le classi note LA STESSA voce si risolve.
        const nota = etichettaDestinatario(UUID_SEZIONE, CLASSI_UNA_SEDE)
        expect(nota.risolta && nota.testo).toBe('TEST Infanzia')
    })

    it('un NOME storico non più in elenco resta leggibile (non è un uuid)', () => {
        // Una classe soppressa scritta per nome: «Girasoli» è comprensibile, e
        // nasconderla dietro «classe non disponibile» toglierebbe informazione.
        const e = etichettaDestinatario('Girasoli', CLASSI)

        expect(e.risolta).toBe(true)
        expect(e.risolta && e.testo).toBe('Girasoli')
    })

    it('l\'id vince sul nome: due classi non si confondono per omonimia di stringa', () => {
        // Caso limite volutamente cattivo: una classe il cui NOME coincide con
        // l'ID di un'altra. L'identità deve avere la precedenza.
        const classi: ClasseNota[] = [
            { id: 'sez-x', nome: UUID_SEZIONE, scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
            { id: UUID_SEZIONE, nome: 'TEST Infanzia', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
        ]

        const e = etichettaDestinatario(UUID_SEZIONE, classi)
        expect(e.risolta && e.testo).toBe('TEST Infanzia')
    })

    it('una voce vuota non produce un\'etichetta vuota a schermo', () => {
        expect(etichettaDestinatario('', CLASSI).risolta).toBe(false)
        expect(etichettaDestinatario('   ', CLASSI).risolta).toBe(false)
    })
})
