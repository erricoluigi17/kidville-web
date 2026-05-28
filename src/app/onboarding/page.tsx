'use client';

import { useState } from 'react';
import { UserPlus, Plus, Trash2, CheckCircle2, ArrowRight } from 'lucide-react';

interface StudentInput {
  nome: string;
  cognome: string;
  data_nascita: string;
  codice_fiscale: string;
  note_mediche: string;
}

export default function OnboardingPage() {
  const [parentFirstName, setParentFirstName] = useState('');
  const [parentLastName, setParentLastName] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [parentFiscalCode, setParentFiscalCode] = useState('');
  const [parentAddress, setParentAddress] = useState('');

  const [students, setStudents] = useState<StudentInput[]>([
    { nome: '', cognome: '', data_nascita: '', codice_fiscale: '', note_mediche: '' }
  ]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleAddStudent = () => {
    setStudents([
      ...students,
      { nome: '', cognome: '', data_nascita: '', codice_fiscale: '', note_mediche: '' }
    ]);
  };

  const handleRemoveStudent = (index: number) => {
    if (students.length === 1) return;
    setStudents(students.filter((_, i) => i !== index));
  };

  const handleStudentChange = (index: number, field: keyof StudentInput, value: string) => {
    const updated = [...students];
    updated[index][field] = value;
    setStudents(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage('');

    // Validations
    if (!parentFirstName || !parentLastName || !parentEmail) {
      setErrorMessage('Si prega di compilare tutti i campi obbligatori del genitore.');
      setIsSubmitting(false);
      return;
    }

    for (let i = 0; i < students.length; i++) {
      const s = students[i];
      if (!s.nome || !s.cognome || !s.data_nascita) {
        setErrorMessage(`Si prega di completare i dati obbligatori per l'alunno #${i + 1}.`);
        setIsSubmitting(false);
        return;
      }
    }

    try {
      const res = await fetch('/api/admin/pre-inscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_first_name: parentFirstName,
          parent_last_name: parentLastName,
          parent_email: parentEmail,
          parent_phone: parentPhone,
          parent_fiscal_code: parentFiscalCode,
          parent_address: parentAddress,
          students
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Errore durante l\'invio');
      }

      setIsSuccess(true);
    } catch (err: any) {
      setErrorMessage(err.message || 'Si è verificato un errore imprevisto.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="min-h-screen bg-kidville-cream flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white p-8 rounded-card shadow-sm text-center border border-emerald-100">
          <div className="w-20 h-20 bg-kidville-success/15 text-kidville-success rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={44} />
          </div>
          <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide mb-3">
            Iscrizione Inviata!
          </h1>
          <p className="font-maven text-gray-600 mb-8 leading-relaxed">
            La tua richiesta di pre-iscrizione è stata inoltrata con successo alla Segreteria.
            Riceverai un'email con le credenziali d'accesso non appena l'iscrizione sarà approvata.
          </p>
          <div className="bg-kidville-cream/50 p-4 rounded-xl text-left border border-kidville-green/10 mb-8">
            <h4 className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wider mb-2">Prossimi Passaggi:</h4>
            <ol className="list-decimal list-inside font-maven text-xs text-gray-600 space-y-1.5">
              <li>La Segreteria verificherà la documentazione in Sala d'Attesa.</li>
              <li>Riceverai le credenziali temporanee via email.</li>
              <li>Effettuerai il primo accesso per firmare la modulistica obbligatoria.</li>
            </ol>
          </div>
          <button
            onClick={() => {
              setParentFirstName('');
              setParentLastName('');
              setParentEmail('');
              setParentPhone('');
              setParentFiscalCode('');
              setParentAddress('');
              setStudents([{ nome: '', cognome: '', data_nascita: '', codice_fiscale: '', note_mediche: '' }]);
              setIsSuccess(false);
            }}
            className="w-full h-12 font-barlow font-black uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity"
          >
            Invia un'altra iscrizione
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kidville-cream py-10 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="font-barlow font-black text-4xl sm:text-5xl text-kidville-green uppercase tracking-wide flex items-center justify-center gap-2">
            <UserPlus size={36} className="text-kidville-yellow" /> Portale di Pre-Iscrizione
          </h1>
          <p className="font-maven text-gray-500 mt-2 text-base sm:text-lg">
            Compila la scheda informativa per avviare l'onboarding legale della tua famiglia.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Sezione Genitore */}
          <div className="bg-white rounded-card p-6 sm:p-8 shadow-sm border border-gray-100">
            <h2 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide mb-6 border-b border-gray-100 pb-3">
              1. Informazioni Genitore / Tutore
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                  Nome *
                </label>
                <input
                  type="text"
                  required
                  value={parentFirstName}
                  onChange={e => setParentFirstName(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                  placeholder="Es. Sarah"
                />
              </div>

              <div>
                <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                  Cognome *
                </label>
                <input
                  type="text"
                  required
                  value={parentLastName}
                  onChange={e => setParentLastName(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                  placeholder="Es. Pagano"
                />
              </div>

              <div>
                <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                  Indirizzo Email *
                </label>
                <input
                  type="email"
                  required
                  value={parentEmail}
                  onChange={e => setParentEmail(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                  placeholder="Es. sarah.pagano@email.it"
                />
              </div>

              <div>
                <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                  Numero di Telefono
                </label>
                <input
                  type="tel"
                  value={parentPhone}
                  onChange={e => setParentPhone(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                  placeholder="Es. 3331234567"
                />
              </div>

              <div>
                <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                  Codice Fiscale Genitore
                </label>
                <input
                  type="text"
                  maxLength={16}
                  value={parentFiscalCode}
                  onChange={e => setParentFiscalCode(e.target.value.toUpperCase())}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green uppercase transition-colors"
                  placeholder="16 caratteri"
                />
              </div>

              <div>
                <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                  Indirizzo di Residenza
                </label>
                <input
                  type="text"
                  value={parentAddress}
                  onChange={e => setParentAddress(e.target.value)}
                  className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                  placeholder="Via Roma 12, Milano"
                />
              </div>
            </div>
          </div>

          {/* Sezione Alunni */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">
                2. Dati Alunni (Figli)
              </h2>
              <button
                type="button"
                onClick={handleAddStudent}
                className="flex items-center gap-1.5 px-4 py-2 bg-kidville-green text-kidville-yellow rounded-pill font-barlow font-black uppercase text-xs sm:text-sm tracking-wide shadow-sm hover:opacity-95 transition-opacity"
              >
                <Plus size={16} /> Aggiungi Nuovo Alunno
              </button>
            </div>

            {students.map((student, index) => (
              <div key={index} className="bg-white rounded-card p-6 sm:p-8 shadow-sm border border-gray-100 relative">
                {students.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveStudent(index)}
                    className="absolute top-6 right-6 text-gray-400 hover:text-red-500 transition-colors p-1"
                    title="Rimuovi questo figlio"
                  >
                    <Trash2 size={18} />
                  </button>
                )}

                <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-6 flex items-center gap-2">
                  <span className="w-6 h-6 bg-kidville-cream text-kidville-green rounded-full flex items-center justify-center text-xs font-black">
                    {index + 1}
                  </span>
                  Scheda Alunno
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                      Nome Alunno *
                    </label>
                    <input
                      type="text"
                      required
                      value={student.nome}
                      onChange={e => handleStudentChange(index, 'nome', e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                      placeholder="Nome del bambino"
                    />
                  </div>

                  <div>
                    <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                      Cognome Alunno *
                    </label>
                    <input
                      type="text"
                      required
                      value={student.cognome}
                      onChange={e => handleStudentChange(index, 'cognome', e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                      placeholder="Cognome del bambino"
                    />
                  </div>

                  <div>
                    <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                      Data di Nascita *
                    </label>
                    <input
                      type="date"
                      required
                      value={student.data_nascita}
                      onChange={e => handleStudentChange(index, 'data_nascita', e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                      Codice Fiscale Alunno
                    </label>
                    <input
                      type="text"
                      maxLength={16}
                      value={student.codice_fiscale}
                      onChange={e => handleStudentChange(index, 'codice_fiscale', e.target.value.toUpperCase())}
                      className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 font-maven text-sm focus:outline-none focus:border-kidville-green uppercase transition-colors"
                      placeholder="16 caratteri"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block font-maven font-semibold text-sm text-kidville-green mb-1.5">
                      Allergie, Intolleranze o Note Medico-Didattiche (opzionale)
                    </label>
                    <textarea
                      value={student.note_mediche}
                      onChange={e => handleStudentChange(index, 'note_mediche', e.target.value)}
                      className="w-full border-2 border-gray-100 rounded-xl p-3 font-maven text-sm focus:outline-none focus:border-kidville-green resize-none h-24 transition-colors"
                      placeholder="Segnalare qui eventuali allergie alimentari, condizioni di salute o note rilevanti..."
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Messaggi di errore */}
          {errorMessage && (
            <div className="bg-red-50 text-red-600 font-maven text-sm p-4 rounded-xl border border-red-200">
              {errorMessage}
            </div>
          )}

          {/* Bottone Invio Form */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full h-14 font-barlow font-black text-xl uppercase tracking-wider rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-lg"
          >
            {isSubmitting ? (
              <span className="w-6 h-6 border-2 border-kidville-yellow/30 border-t-kidville-yellow rounded-full animate-spin" />
            ) : (
              <>
                Invia Pre-Iscrizione <ArrowRight size={20} />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
