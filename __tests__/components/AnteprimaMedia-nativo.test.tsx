import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'
import { AnteprimaMedia } from '@/components/features/gallery/AnteprimaMedia'

/**
 * L'ANTEPRIMA DI UN VIDEO NATIVO — `AnteprimaMedia` con `file={null}` (app 1.2, spec «caricamenti nativi»
 * §7.3, compito J2).
 *
 * Un video scelto dal selettore NATIVO non ha un `File`: non c'è nessun objectURL da dare a un `<video>`.
 * L'anteprima è la MINIATURA che il plugin ha già fatto (un JPEG in data URL) e si dipinge con un `<img>`.
 * `file: null` è la stessa forma dell'elemento caricabile (`ElementoCaricabile`), così le tre tessere che
 * chiamano il componente passano `f.file` com'è.
 *
 * I rami di prima (un `File` video → `<video>`, un `File` immagine → `<img>`) hanno il loro file
 * (`MediaUploader-anteprima-video.test.tsx`): qui se ne prova uno solo, perché il ramo nuovo non li abbia
 * spostati.
 *
 * Ogni caso è stato visto ROSSO rompendo il codice che prova (le mutazioni sono nel rapporto di J2).
 */

const MINIATURA = 'data:image/jpeg;base64,/9j/AAAA'

/** Le tessere vere sono `relative`: la pastiglia è posizionata in assoluto rispetto a loro. */
const tessera = (props: React.ComponentProps<typeof AnteprimaMedia>) =>
  render(<div className="relative"><AnteprimaMedia {...props} /></div>)

describe('un video NATIVO (`file={null}`) si dipinge con la sua miniatura', () => {
  it('un <img> con la data URL, decorativo (`alt` vuoto), e MAI un <video>', () => {
    const { container } = tessera({ file: null, src: MINIATURA })
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(MINIATURA)
    expect(img.getAttribute('alt')).toBe('')
    expect(container.querySelector('video'), 'non c’è niente da riprodurre: i byte stanno sul telefono').toBeNull()
  })

  it('la pastiglia «Video» c’è, con la parola visibile (`con-parola`, il predefinito)', () => {
    const { getByText } = tessera({ file: null, src: MINIATURA })
    const parola = getByText(itShared.galleryVideo)
    expect(parola.className).not.toContain('sr-only')
  })

  it('`solo-icona`: la parola resta per gli screen reader (`sr-only`); `nessuna`: niente pastiglia', () => {
    const solo = tessera({ file: null, src: MINIATURA, etichetta: 'solo-icona' })
    expect(solo.getByText(itShared.galleryVideo).className).toContain('sr-only')
    solo.unmount()

    const nessuna = tessera({ file: null, src: MINIATURA, etichetta: 'nessuna' })
    expect(nessuna.queryByText(itShared.galleryVideo)).toBeNull()
    expect(nessuna.container.querySelector('img')).toBeTruthy()
  })

  it('SENZA miniatura (`src` vuota) NON si dipinge un <img> senza sorgente (è il glifo del file rotto): riquadro neutro col triangolino', () => {
    const { container, getByText } = tessera({ file: null, src: '' })
    expect(container.querySelector('img'), 'un <img> senza sorgente').toBeNull()
    expect(container.querySelector('video')).toBeNull()
    // Il triangolino è decorativo; «Video» lo dice la pastiglia, che resta.
    const riquadro = container.querySelector('svg[aria-hidden="true"]')
    expect(riquadro).toBeTruthy()
    expect(getByText(itShared.galleryVideo)).toBeInTheDocument()
  })

  it('le classi dell’elemento passano al <img> e al riquadro neutro (la tessera decide le misure)', () => {
    const conMiniatura = tessera({ file: null, src: MINIATURA, className: 'w-10 h-10 object-cover' })
    expect(conMiniatura.container.querySelector('img')?.className).toBe('w-10 h-10 object-cover')
    conMiniatura.unmount()
    const senza = tessera({ file: null, src: '', className: 'w-10 h-10 object-cover' })
    expect(senza.container.querySelector('.relative > div')?.className).toContain('w-10 h-10')
  })
})

describe('i rami di prima non si sono mossi', () => {
  it('un `File` video resta un <video> con la sua pastiglia; un `File` immagine resta un <img>', () => {
    const video = tessera({ file: { type: 'video/mp4' }, src: 'blob:video' })
    expect(video.container.querySelector('video')?.getAttribute('src')).toBe('blob:video')
    expect(video.getByText(itShared.galleryVideo)).toBeInTheDocument()
    video.unmount()

    const immagine = tessera({ file: { type: 'image/jpeg' }, src: 'blob:foto' })
    expect(immagine.container.querySelector('img')?.getAttribute('src')).toBe('blob:foto')
    expect(immagine.container.querySelector('video')).toBeNull()
    expect(immagine.queryByText(itShared.galleryVideo)).toBeNull()
  })
})
