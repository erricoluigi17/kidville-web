import { mimeBase } from './limiti'

// I video entrano nella pipeline FFmpeg e saranno convertiti in MP4; i MIME del
// bucket `gallery` descrivono l'USCITA e non sono la lista degli ingressi.
const MIME_INPUT = [
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
    'video/3gpp', 'video/3gpp2', 'video/x-matroska', 'video/x-msvideo',
    'video/mpeg', 'video/ogg', 'video/x-flv', 'video/mp2t',
    'video/x-ms-wmv', 'video/x-ms-asf',
] as const
type MimeInput = (typeof MIME_INPUT)[number]

function tipoDaiByte(bytes: Uint8Array): MimeInput | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png'
    if (bytes.length >= 12 && [82, 73, 70, 70].every((byte, i) => bytes[i] === byte)
        && [87, 69, 66, 80].every((byte, i) => bytes[i + 8] === byte)) return 'image/webp'
    if (bytes.length >= 12 && [102, 116, 121, 112].every((byte, i) => bytes[i + 4] === byte)) {
        // ISO-BMFF contiene anche HEIC/HEIF: `ftyp` da solo non prova un video.
        const brand = String.fromCharCode(...bytes.slice(8, 12))
        if (brand === 'qt  ') return 'video/quicktime'
        if (brand === 'M4V ') return 'video/x-m4v'
        if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', '3gp4', '3gp5'].includes(brand)) return 'video/mp4'
        return null
    }
    if (bytes.length >= 4 && [26, 69, 223, 163].every((byte, i) => bytes[i] === byte)) return 'video/webm'
    return null
}

function leggiIntestazione(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const lettore = new FileReader()
        lettore.onerror = () => reject(new Error('lettura_file_fallita'))
        lettore.onload = () => resolve(new Uint8Array(lettore.result as ArrayBuffer))
        lettore.readAsArrayBuffer(file.slice(0, 16))
    })
}

/** Normalizza i file senza MIME leggendo la firma, mai il nome o l'estensione. */
export async function classificaFileGalleria(file: File): Promise<File | null> {
    const dichiarato = mimeBase(file.type)
    if (dichiarato) return (MIME_INPUT as readonly string[]).includes(dichiarato) ? file : null
    const rilevato = tipoDaiByte(await leggiIntestazione(file))
    return rilevato ? new File([file], file.name, { type: rilevato, lastModified: file.lastModified }) : null
}
