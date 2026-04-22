import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export interface AddressSuggestion {
  label: string;
  adresse: string;
  codePostal: string | null;
  ville: string | null;
  latitude: number;
  longitude: number;
}

interface Props {
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
  onSelect: (suggestion: AddressSuggestion) => void;
}

export function AddressAutocomplete({
  value,
  placeholder = "Adresse d'implantation",
  onValueChange,
  onSelect,
}: Props) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const query = value.trim();
    const seq = ++requestSeq.current;

    if (query.length < 3) {
      setSuggestions([]);
      setLoading(false);
      setWarning(null);
      return;
    }

    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api<{ suggestions: AddressSuggestion[] }>(
          `/api/geocoding/search?q=${encodeURIComponent(query)}&limit=5`,
        );
        if (seq !== requestSeq.current) return;
        setSuggestions(result.suggestions || []);
        setWarning(null);
      } catch {
        if (seq !== requestSeq.current) return;
        setSuggestions([]);
        setWarning('BAN indisponible: vous pouvez continuer en saisie manuelle.');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
      />
      {loading && <div className="hint">Recherche BAN…</div>}
      {warning && <div className="hint" style={{ color: 'var(--c-warning)' }}>{warning}</div>}
      {!loading && suggestions.length > 0 && (
        <div className="card" style={{ marginTop: 6, padding: 0 }}>
          <table className="table">
            <tbody>
              {suggestions.map((s, idx) => (
                <tr key={`${s.label}-${idx}`} className="clickable" onClick={() => onSelect(s)}>
                  <td>
                    <strong>{s.label}</strong>
                    <div className="hint">
                      {s.codePostal || '-'} {s.ville || ''} · {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
