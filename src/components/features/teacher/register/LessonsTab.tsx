'use client';

import { useState } from 'react';
import { PenTool, Upload, CheckCircle } from 'lucide-react';

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8];

export default function LessonsTab() {
    const [signedHours, setSignedHours] = useState<number[]>([]);

    const handleSign = (hour: number) => {
        if (!signedHours.includes(hour)) {
            setSignedHours([...signedHours, hour]);
        }
    };

    return (
        <div>
            <h2 className="font-barlow font-bold text-2xl text-kidville-green mb-4">Orario e Firme</h2>
            <div className="flex flex-col gap-3">
                {HOURS.map((hour) => {
                    const isSigned = signedHours.includes(hour);
                    return (
                        <div key={hour} className="border border-gray-100 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:shadow-sm transition-shadow">
                            <div className="w-12 h-12 bg-kidville-cream text-kidville-green rounded-full flex items-center justify-center font-barlow font-bold text-xl flex-shrink-0">
                                {hour}°
                            </div>
                            
                            <div className="flex-1">
                                {isSigned ? (
                                    <div>
                                        <div className="font-maven font-semibold text-kidville-green">Italiano</div>
                                        <div className="text-sm text-gray-500 font-maven mt-1">
                                            <strong>Argomento:</strong> I Promessi Sposi - Cap. 1<br/>
                                            <strong>Compiti:</strong> Leggere pag. 12-15
                                        </div>
                                    </div>
                                ) : (
                                    <div className="text-gray-400 italic text-sm">Nessuna firma registrata per quest'ora.</div>
                                )}
                            </div>

                            <div className="flex gap-2">
                                {!isSigned ? (
                                    <button 
                                        onClick={() => handleSign(hour)}
                                        className="h-10 px-4 font-maven font-medium rounded-pill bg-kidville-green text-kidville-yellow flex items-center gap-2 hover:opacity-90"
                                    >
                                        <PenTool size={16} /> Firma
                                    </button>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <button className="h-10 px-3 font-maven rounded-pill bg-kidville-cream text-kidville-green flex items-center gap-2 hover:bg-gray-200">
                                            <Upload size={16} /> Allegato
                                        </button>
                                        <span className="flex items-center gap-1 text-kidville-success text-sm font-semibold">
                                            <CheckCircle size={16} /> Firmato
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
