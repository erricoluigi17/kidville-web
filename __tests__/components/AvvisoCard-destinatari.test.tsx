import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import itAvvisi from '../../messages/it/avvisi.json'
import { AvvisoCard, type Avviso } from '@/components/features/avvisi/AvvisoCard'
import type { ClasseNota } from '@/lib/avvisi/destinatari'

// =============================================================================
// La bacheca del docente non stampa più l'identificativo di una sezione.
//
// Collaudo iOS del 2026-07-31, rilievo F4: due card su cinque mostravano come
// destinatario `219cab6a-2bf3-48d6-a443-b7aecda40f42` — l'ID della sezione
// «TEST Infanzia» — dove le altre mostravano «Tutti» o «TEST 1A». Gli STESSI
// avvisi, nel cockpit della segreteria, dicevano «TEST Infanzia»: due letture
// diverse dello stesso campo, e quella povera era quella del docente.
//
// È la stessa famiglia di difetti che ha aperto l'audit multi-sede: con un
// plesso solo il NOME della classe era di fatto una chiave, e chi archiviava
// l'id produceva comunque un dato leggibile. Con tre sedi non è più così.
//
// METODO. Le asserzioni che contano sono sul TESTO RESO, non su uno stato
// interno, e ogni negativa ha accanto la sua positiva:
//  · «non c'è l'uuid» da solo passerebbe anche con la card vuota → accanto c'è
//    «c'è scritto TEST Infanzia»;
//  · l'uuid si cerca anche nell'`innerHTML` (title, aria-label): nascosto in un
//    attributo è comunque esposto a chi usa uno screen reader;
//  · la card senza classi note (il genitore) deve dire una parola comprensibile,
//    e la stessa card CON le classi note deve dire il nome: è il controllo che
//    dimostra che l'etichetta neutra non è una scorciatoia per non risolvere.
// =============================================================================

afterEach(cleanup)

/** L'uuid di una sezione: forma vera, valore inventato (nessun dato di produzione). */
const UUID_SEZIONE = '11111111-2222-4333-8444-555555555555'

const CLASSI_UNA_SEDE: ClasseNota[] = [
    { id: UUID_SEZIONE, nome: 'TEST Infanzia', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    { id: 'sez-a-1a', nome: 'TEST 1A', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
]

const CLASSI_DUE_SEDI: ClasseNota[] = [
    ...CLASSI_UNA_SEDE,
    { id: 'sez-b-2anni', nome: '2 ANNI', scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B },
]

function avvisoCon(target_classes: string[] | null, target_scope = 'classe'): Avviso {
    return {
        id: 'avv-1',
        author_id: 'aut-1',
        titolo: 'Gita al parco',
        contenuto: 'Si parte alle 9.',
        tipo: 'presa_visione',
        target_scope,
        target_classes,
        scadenza: null,
        attachment_url: null,
        created_at: '2026-07-31T08:00:00.000Z',
        author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
        stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
    }
}

describe('AvvisoCard — il destinatario è una classe, non un identificativo', () => {
    it('risolve l\'id di sezione nel nome, come fa il cockpit (iOS F4)', () => {
        const { container } = render(
            <AvvisoCard avviso={avvisoCon([UUID_SEZIONE])} index={0} isTeacher classiNote={CLASSI_UNA_SEDE} />,
        )

        // Positiva: la pill dice la classe vera.
        expect(screen.getByText('TEST Infanzia')).toBeInTheDocument()
        // Negativa, che senza quella sopra non varrebbe nulla: l'uuid non è a
        // schermo NÉ in un attributo (title/aria-label sono letti dagli SR).
        expect(container.textContent).not.toContain(UUID_SEZIONE)
        expect(container.innerHTML).not.toContain(UUID_SEZIONE)
    })

    it('un nome di classe già leggibile resta invariato (controllo positivo)', () => {
        render(<AvvisoCard avviso={avvisoCon(['TEST 1A'])} index={0} isTeacher classiNote={CLASSI_UNA_SEDE} />)

        expect(screen.getByText('TEST 1A')).toBeInTheDocument()
    })

    it('senza classi note (genitore) dice una parola comprensibile, mai l\'uuid', () => {
        const { container, unmount } = render(<AvvisoCard avviso={avvisoCon([UUID_SEZIONE])} index={0} />)

        expect(screen.getByText(itAvvisi.classeSconosciuta)).toBeInTheDocument()
        expect(container.textContent).not.toContain(UUID_SEZIONE)
        expect(container.innerHTML).not.toContain(UUID_SEZIONE)

        // Controllo positivo accanto: la STESSA voce, con le classi note, si
        // risolve. Senza questo, un'etichetta neutra sempre e comunque passerebbe.
        unmount()
        render(<AvvisoCard avviso={avvisoCon([UUID_SEZIONE])} index={0} isTeacher classiNote={CLASSI_UNA_SEDE} />)
        expect(screen.getByText('TEST Infanzia')).toBeInTheDocument()
    })

    it('con più sedi in gioco la pill dice anche il plesso', () => {
        render(<AvvisoCard avviso={avvisoCon([UUID_SEZIONE])} index={0} isTeacher classiNote={CLASSI_DUE_SEDI} />)

        expect(screen.getByText(`TEST Infanzia — ${NOME_SEDE_A}`)).toBeInTheDocument()
    })

    it('l\'avviso di plesso continua a dire «Tutti» (niente regressioni)', () => {
        render(<AvvisoCard avviso={avvisoCon(null, 'globale')} index={0} isTeacher classiNote={CLASSI_UNA_SEDE} />)

        expect(screen.getByText(itAvvisi.tutti)).toBeInTheDocument()
    })

    it('due voci diverse restano due pill distinte', () => {
        render(
            <AvvisoCard
                avviso={avvisoCon([UUID_SEZIONE, 'TEST 1A'])}
                index={0}
                isTeacher
                classiNote={CLASSI_UNA_SEDE}
            />,
        )

        expect(screen.getByText('TEST Infanzia')).toBeInTheDocument()
        expect(screen.getByText('TEST 1A')).toBeInTheDocument()
    })
})
