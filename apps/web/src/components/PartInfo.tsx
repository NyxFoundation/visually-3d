import React from 'react';

interface Part {
  id: string;
  name: string;
  material: string;
  role: string;
  connections?: string[];
}

interface PartInfoProps {
  part: Part | null;
  onClose: () => void;
}

export const PartInfo: React.FC<PartInfoProps> = ({ part, onClose }) => {
  if (!part) return null;

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-black/60 backdrop-blur-md text-white border-l border-white/20 p-6 shadow-2xl z-50 transition-all duration-300 ease-in-out transform translate-x-0">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold truncate">{part.name}</h2>
        <button 
          onClick={onClose}
          className="p-1 hover:bg-white/20 rounded-full transition-colors"
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div className="space-y-6">
        <section>
          <label className="text-xs uppercase tracking-wider text-gray-400 font-semibold">Material</label>
          <p className="text-sm mt-1">{part.material}</p>
        </section>

        <section>
          <label className="text-xs uppercase tracking-wider text-gray-400 font-semibold">Role</label>
          <p className="text-sm mt-1">{part.role}</p>
        </section>

        {part.connections && part.connections.length > 0 && (
          <section>
            <label className="text-xs uppercase tracking-wider text-gray-400 font-semibold">Connections</label>
            <ul className="text-sm mt-1 list-disc pl-4">
              {part.connections.map((conn, idx) => (
                <li key={idx}>{conn}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
};
