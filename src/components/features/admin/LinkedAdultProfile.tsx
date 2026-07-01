import React from 'react';
import { User, IdCard, Download, Mail, Phone, MapPin } from 'lucide-react';

export type AdultType = 'mother' | 'father' | 'delegate';

export interface AdultProfileData {
    id: string;
    first_name: string;
    last_name: string;
    gender?: string;
    birth_date?: string;
    birth_city?: string;
    fiscal_code?: string;
    emails?: string[];
    phone_numbers?: string[];
    residence_address?: string;
    residence_city?: string;
    document_type?: string;
    document_number?: string;
    document_url?: string; // per delegati
}

interface Props {
    data: AdultProfileData;
    type: AdultType;
}

export function LinkedAdultProfile({ data, type }: Props) {
    const Icon = type === 'delegate' ? IdCard : User;

    const Label = ({ children }: { children: React.ReactNode }) => (
        <label className="block text-[10px] text-kidville-muted tracking-wider uppercase mb-1">
            {children}
        </label>
    );

    const Value = ({ children }: { children: React.ReactNode }) => (
        <div className="text-kidville-line font-medium text-sm truncate" title={typeof children === 'string' ? children : ''}>
            {children || '—'}
        </div>
    );

    const formatDate = (dateStr?: string) => {
        if (!dateStr) return '—';
        try {
            return new Date(dateStr).toLocaleDateString('it-IT');
        } catch {
            return dateStr;
        }
    };

    return (
        <div className="bg-white backdrop-blur-md rounded-2xl border border-kidville-green/15 p-5 mt-4 shadow-inner">
            <div className="flex items-center gap-3 mb-5 border-b border-kidville-green/15 pb-3">
                <div className="w-10 h-10 rounded-full bg-kidville-green/20 flex items-center justify-center text-kidville-green">
                    <Icon size={20} />
                </div>
                <div>
                    <h4 className="font-barlow font-bold text-lg text-kidville-green uppercase tracking-wide leading-tight">
                        {data.first_name} {data.last_name}
                    </h4>
                    <p className="text-xs text-kidville-muted capitalize font-maven">
                        {type === 'mother' ? 'Madre' : type === 'father' ? 'Padre' : 'Delegato'}
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 font-maven">
                {/* Dati Personali */}
                <div className="space-y-4">
                    <div>
                        <Label>Sesso</Label>
                        <Value>{data.gender === 'F' ? 'Femmina' : data.gender === 'M' ? 'Maschio' : data.gender}</Value>
                    </div>
                    <div>
                        <Label>Nato/a il</Label>
                        <Value>{formatDate(data.birth_date)}</Value>
                    </div>
                    <div>
                        <Label>Luogo di Nascita</Label>
                        <Value>{data.birth_city}</Value>
                    </div>
                    <div>
                        <Label>Codice Fiscale</Label>
                        <Value>
                            <span className="uppercase">{data.fiscal_code}</span>
                        </Value>
                    </div>
                </div>

                {/* Contatti e Residenza */}
                <div className="space-y-4">
                    <div>
                        <Label>Email</Label>
                        <div className="flex items-center gap-2">
                            <Mail size={14} className="text-kidville-muted flex-shrink-0" />
                            <Value>{data.emails?.[0]}</Value>
                        </div>
                    </div>
                    <div>
                        <Label>Cellulare</Label>
                        <div className="flex items-center gap-2">
                            <Phone size={14} className="text-kidville-muted flex-shrink-0" />
                            <Value>{data.phone_numbers?.[0]}</Value>
                        </div>
                    </div>
                    <div>
                        <Label>Residenza</Label>
                        <div className="flex items-start gap-2">
                            <MapPin size={14} className="text-kidville-muted flex-shrink-0 mt-0.5" />
                            <Value>
                                {data.residence_address ? `${data.residence_address}, ${data.residence_city || ''}` : '—'}
                            </Value>
                        </div>
                    </div>
                </div>

                {/* Documento Delegato */}
                {type === 'delegate' && (
                    <div className="space-y-4 lg:col-span-1 md:col-span-2">
                        <div className="bg-kidville-cream rounded-xl p-4 border border-kidville-green/10 h-full">
                            <Label>Documento d&apos;Identità</Label>
                            <div className="mt-2 space-y-3">
                                <div>
                                    <div className="text-xs text-kidville-muted mb-0.5">Tipo:</div>
                                    <Value>{data.document_type || 'Non specificato'}</Value>
                                </div>
                                <div>
                                    <div className="text-xs text-kidville-muted mb-0.5">Numero:</div>
                                    <Value>{data.document_number || 'Non specificato'}</Value>
                                </div>
                                
                                {data.document_url && (
                                    <a 
                                        href={data.document_url} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        className="mt-4 flex items-center gap-2 justify-center w-full py-2 bg-kidville-green/20 text-kidville-green hover:bg-kidville-green/30 transition-colors rounded-lg text-xs font-bold font-barlow uppercase tracking-wider border border-kidville-green/30"
                                    >
                                        <Download size={14} /> 
                                        Visualizza Allegato
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
