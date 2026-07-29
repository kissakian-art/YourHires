import { useState, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';

interface UnitOfMeasure {
  id: number;
  code: string;
  name: string;
  abbreviation: string;
  category?: string;
}

interface SearchableSelectProps {
  options: UnitOfMeasure[];
  value: number | '';
  onChange: (value: number | '') => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export default function SearchableUnitSelect({
  options,
  value,
  onChange,
  placeholder = 'Select unit...',
  disabled = false,
  className = '',
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((opt) => opt.id === value);

  // Filter options based on search term
  const filteredOptions = options.filter((option) => {
    const search = searchTerm.toLowerCase();
    return (
      option.name.toLowerCase().includes(search) ||
      option.abbreviation.toLowerCase().includes(search) ||
      option.code.toLowerCase().includes(search) ||
      (option.category && option.category.toLowerCase().includes(search))
    );
  });

  // Group options by category
  const groupedOptions = filteredOptions.reduce((acc, option) => {
    const category = option.category || 'other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(option);
    return acc;
  }, {} as Record<string, UnitOfMeasure[]>);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when opening
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelect = (optionId: number) => {
    onChange(optionId);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setSearchTerm('');
  };

  const categoryOrder = ['quantity', 'weight', 'volume', 'length', 'area', 'time', 'container', 'power', 'service', 'currency', 'other'];
  const sortedCategories = Object.keys(groupedOptions).sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a);
    const bIndex = categoryOrder.indexOf(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Select Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`w-full h-full flex items-center justify-between gap-2 px-3 py-2 bg-neo border-none shadow-neo-inset-sm rounded-xl text-left text-xs font-bold text-slate-700 dark:text-slate-350 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all duration-200 ${
          disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
        }`}
      >
        <span
          className={
            selectedOption
              ? 'text-slate-800 dark:text-slate-200'
              : 'text-slate-450 dark:text-slate-500'
          }
        >
          {selectedOption ? (
            <>
              {selectedOption.name} ({selectedOption.abbreviation})
              {selectedOption.category && (
                <span className="text-[10px] text-slate-400 ml-2 uppercase font-black tracking-wider">· {selectedOption.category}</span>
              )}
            </>
          ) : (
            placeholder
          )}
        </span>
        <div className="flex items-center gap-1.5">
          {selectedOption && !disabled && (
            <X
              className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
              onClick={handleClear}
            />
          )}
          <svg
            className={`w-3.5 h-3.5 text-slate-450 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute left-0 right-0 mt-2 z-50 max-h-60 overflow-y-auto bg-neo shadow-neo-outset border border-slate-200/10 dark:border-slate-800/10 rounded-2xl p-2.5 animate-in slide-in-from-top-1 duration-150">
          {/* Search Input */}
          <div className="relative mb-2 shrink-0">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search unit..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-neo shadow-neo-inset-sm border-none rounded-lg text-xs font-bold text-slate-700 dark:text-slate-300 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
            />
          </div>

          {/* Options List */}
          <div className="overflow-y-auto max-h-44 pr-0.5 space-y-2">
            {sortedCategories.length === 0 ? (
              <p className="text-[10px] text-center text-slate-450 dark:text-slate-500 py-3">No units found</p>
            ) : (
              sortedCategories.map((category) => (
                <div key={category} className="space-y-1">
                  <div className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest px-2 py-0.5 border-b border-slate-200/5">
                    {category}
                  </div>
                  <div className="space-y-0.5">
                    {groupedOptions[category].map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => handleSelect(option.id)}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center justify-between ${
                          value === option.id
                            ? 'bg-blue-600 text-white shadow-md'
                            : 'text-slate-650 dark:text-slate-350 hover:bg-slate-200/5'
                        }`}
                      >
                        <span>{option.name}</span>
                        <span className={`text-[10px] font-mono font-bold ${value === option.id ? 'text-white/80' : 'text-slate-400'}`}>
                          {option.abbreviation}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
