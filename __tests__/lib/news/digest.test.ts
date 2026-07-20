import { describe, it, expect } from 'vitest'
import { componiDigest, type PostDigest } from '@/lib/news/digest'

// =============================================================================
// Composizione del digest mensile — funzione PURA. Include TUTTI i pubblicati
// del mese (anche i post a target classi — decisione 14), esclude bozze/nascoste
// e i post di altri mesi; ordina pinned poi pubblicata_il DESC; mese vuoto → null.
// =============================================================================

const SEDE = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

const posts: PostDigest[] = [
  { id: 'a', titolo: 'Festa di fine anno', stato: 'pubblicata', pinned: false, pubblicata_il: '2026-06-10T09:00:00Z', contenuto_testo: 'Una grande festa', categoria_nome: 'Eventi e feste', target_scope: 'globale' },
  { id: 'b', titolo: 'Comunicato in evidenza', stato: 'pubblicata', pinned: true, pubblicata_il: '2026-06-05T09:00:00Z', contenuto_testo: 'Importante', categoria_nome: 'Comunicati', target_scope: 'globale' },
  { id: 'c', titolo: 'Bozza non pubblicata', stato: 'bozza', pinned: false, pubblicata_il: null, contenuto_testo: '', categoria_nome: null, target_scope: 'globale' },
  { id: 'd', titolo: 'Post nascosto', stato: 'nascosta', pinned: false, pubblicata_il: '2026-06-15T09:00:00Z', contenuto_testo: '', categoria_nome: null, target_scope: 'globale' },
  { id: 'e', titolo: 'Del mese scorso', stato: 'pubblicata', pinned: false, pubblicata_il: '2026-05-20T09:00:00Z', contenuto_testo: '', categoria_nome: null, target_scope: 'globale' },
  { id: 'f', titolo: 'Uscita di classe', stato: 'pubblicata', pinned: false, pubblicata_il: '2026-06-20T09:00:00Z', contenuto_testo: 'Solo 1A', categoria_nome: 'Vita di scuola', target_scope: 'classi' },
]

describe('componiDigest', () => {
  it('include i soli pubblicati del mese, ordinati pinned poi data DESC', () => {
    const res = componiDigest(posts, { scuolaId: SEDE, anno: 2026, mese: 6, nomeSede: 'Kidville Giugliano' })
    expect(res).not.toBeNull()
    expect(res!.post_ids).toEqual(['b', 'f', 'a'])
  })

  it('include anche i post a target classi (decisione 14)', () => {
    const res = componiDigest(posts, { scuolaId: SEDE, anno: 2026, mese: 6, nomeSede: 'Kidville Giugliano' })
    expect(res!.post_ids).toContain('f')
  })

  it('esclude bozze, nascoste e post di altri mesi', () => {
    const res = componiDigest(posts, { scuolaId: SEDE, anno: 2026, mese: 6, nomeSede: 'Kidville Giugliano' })
    expect(res!.post_ids).not.toContain('c') // bozza
    expect(res!.post_ids).not.toContain('d') // nascosta
    expect(res!.post_ids).not.toContain('e') // maggio
  })

  it('titolo con mese in italiano e anno', () => {
    const res = componiDigest(posts, { scuolaId: SEDE, anno: 2026, mese: 6, nomeSede: 'Kidville Giugliano' })
    expect(res!.titolo).toContain('Giugno')
    expect(res!.titolo).toContain('2026')
  })

  it('html è una stringa che contiene i titoli dei post e la sede', () => {
    const res = componiDigest(posts, { scuolaId: SEDE, anno: 2026, mese: 6, nomeSede: 'Kidville Giugliano' })
    expect(typeof res!.html).toBe('string')
    expect(res!.html).toContain('Festa di fine anno')
    expect(res!.html).toContain('Comunicato in evidenza')
    expect(res!.html).toContain('Kidville News')
  })

  it('mese senza post pubblicati → null (nessuna edizione)', () => {
    expect(componiDigest(posts, { scuolaId: SEDE, anno: 2026, mese: 1, nomeSede: 'Kidville Giugliano' })).toBeNull()
    expect(componiDigest([], { scuolaId: SEDE, anno: 2026, mese: 6, nomeSede: 'Kidville Giugliano' })).toBeNull()
  })
})
