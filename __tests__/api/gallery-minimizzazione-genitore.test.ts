import { describe, it, expect } from 'vitest'
import { proiettaPerGenitore } from '@/app/api/gallery/proiezione'

/**
 * MINIMIZZAZIONE (GDPR art. 5.1.c) sul ramo del GENITORE di `GET /api/gallery`.
 *
 * La route legge `galleria_media_v2` con `select('*')` e poi propaga `...media`
 * al client. Nel ramo del genitore (`?studentId=`) arrivava quindi anche
 * `tag_students`: gli **uuid degli altri minori ritratti nella stessa foto di
 * gruppo**. Non è sfruttabile — tutti gli endpoint che accettano un uuid di
 * alunno hanno il gate (`requireParentOfStudent`, `assertAlunnoInScope`,
 * verificato) — ed è coerente con la regola in vigore «una foto con più di un
 * bambino taggato non è privata». Ma è un campo che l'interfaccia del genitore
 * NON usa (`tag_students` compare solo in `MediaGrid` e in `teacher/gallery`,
 * cioè in schermate di personale) e che identifica i figli di altre famiglie.
 *
 * Il dato che non esce non si può perdere: qui si toglie alla fonte invece di
 * confidare nel fatto che nessuna schermata lo mostri.
 *
 * Lo staff continua a riceverlo: è lui che tagga, e senza la lista non potrebbe.
 */
describe('proiettaPerGenitore — al genitore non arrivano gli uuid degli altri bambini', () => {
    const media = {
        id: 'm1',
        file_path: 'sede/anno/foto.jpg',
        is_broadcast: false,
        tag_students: ['alunno-mio', 'alunno-di-un-altra-famiglia'],
        uploaded_by: 'u1',
        created_at: '2026-08-02T10:00:00.000Z',
    }

    it('toglie `tag_students` quando chi legge è un genitore', () => {
        const out = proiettaPerGenitore(media, true)
        expect(out).not.toHaveProperty('tag_students')
    })

    it('lascia intatto tutto il resto: la foto resta guardabile', () => {
        const out = proiettaPerGenitore(media, true) as Record<string, unknown>
        expect(out.id).toBe('m1')
        expect(out.file_path).toBe('sede/anno/foto.jpg')
        expect(out.is_broadcast).toBe(false)
        expect(out.created_at).toBe('2026-08-02T10:00:00.000Z')
    })

    it('allo STAFF `tag_students` resta: è lui che tagga', () => {
        const out = proiettaPerGenitore(media, false) as Record<string, unknown>
        expect(out.tag_students).toEqual(['alunno-mio', 'alunno-di-un-altra-famiglia'])
    })

    it('regge un media senza `tag_students` (DB E2E non migrato, colonna assente)', () => {
        const senza = { id: 'm2', file_path: 'x.jpg' }
        expect(proiettaPerGenitore(senza, true)).toEqual({ id: 'm2', file_path: 'x.jpg' })
    })

    it('non muta l\'oggetto originale: la stessa riga può servire due destinatari', () => {
        proiettaPerGenitore(media, true)
        expect(media.tag_students).toHaveLength(2)
    })
})
