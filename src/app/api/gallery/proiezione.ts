/**
 * Che cosa esce dalla galleria, e a chi.
 *
 * `GET /api/gallery` legge `galleria_media_v2` con `select('*')` e propaga
 * `...media` al chiamante. Nel ramo del GENITORE (`?studentId=`) usciva così
 * anche `tag_students`: gli uuid degli **altri minori ritratti nella stessa foto
 * di gruppo**, cioè i figli di altre famiglie.
 *
 * Non è sfruttabile — ogni endpoint che accetta un uuid di alunno ha il proprio
 * gate — ed è coerente con la regola in vigore («una foto con più di un bambino
 * taggato non è privata»). Ma è un campo che l'interfaccia del genitore non usa:
 * `tag_students` compare solo in `MediaGrid` e in `teacher/gallery`, cioè in
 * schermate di personale. GDPR art. 5.1.c: il dato che non serve non si manda.
 *
 * Sta in un file suo, e non dentro il `.map()` della route, per due ragioni:
 * è verificabile senza montare tutta la route, ed è UN posto solo il giorno in
 * cui la galleria avrà una seconda strada di lettura.
 */
export function proiettaPerGenitore<T extends Record<string, unknown>>(
    media: T,
    perGenitore: boolean,
): T | Omit<T, 'tag_students'> {
    if (!perGenitore) return media;
    // Copia: la stessa riga può servire due destinatari nello stesso processo, e
    // un `delete` sull'originale li accontenterebbe entrambi con l'ultimo.
    const { tag_students: _scartato, ...resto } = media;
    void _scartato;
    return resto;
}
