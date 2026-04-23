import React, { useState } from 'react';
import { Viewer } from './components/Viewer';
import { PartInfo } from './components/PartInfo';

const MOCK_SCENE = {
  machine_name: "Demo Machine",
  parts: [
    {
      id: "1",
      name: "Base Plate",
      shape: "box",
      position: [0, 0, 0],
      size: [5, 0.2, 5],
      material: "steel",
      role: "provides structural support"
    },
    {
      id: "2",
      name: "Main Pillar",
      shape: "cylinder",
      position: [0, 1, 0],
      size: [0.5, 2],
      material: "aluminum",
      role: "central support column"
    },
    {
      id: "3",
      name: "Top Knob",
      shape: "sphere",
      position: [0, 2.5, 0],
      size: [0.3],
      material: "plastic",
      role: "adjustment dial"
    },
    {
      id: "4",
      name: "Complex Component",
      shape: "complex",
      position: [2, 0.5, 2],
      size: [0.8, 0.8, 0.8],
      material: "unknown",
      role: "advanced processing unit"
    }
  ]
};

function App() {
  const [selectedPart, setSelectedPart] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scene, setScene] = useState(MOCK_SCENE);

  const handleAnalyze = async (url: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('http://localhost:8000/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer YOUR_API_KEY' },
        body: JSON.stringify({ url })
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Analysis failed');
      }
      const data = await response.json();
      setScene(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container" style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', backgroundColor: '#111' }}>
      {/* Header & Instructions */}
      <div style={{ position: 'absolute', top: 20, left: 20, color: 'white', zIndex: 10, pointerEvents: 'none', fontFamily: 'sans-serif' }}>
        <h1 style={{ margin: 0 }}>{scene.machine_name}</h1>
        <p style={{ margin: 0 }}>3D Visualization Preview</p>
        <div style={{ marginTop: '10px', fontSize: '0.9rem', opacity: 0.8, pointerEvents: 'auto' }}>
          <p>• Click a part to see details</p>
          <p>• Rotate and zoom using the mouse</p>
        </div>
      </div>

      {/* Analysis Input */}
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 10, display: 'flex', gap: '10px' }}>
        <input 
          type="text" 
          placeholder="Enter machine URL..." 
          style={{ padding: '8px', borderRadius: '4px', border: '1px solid #444', background: '#222', color: 'white' }}
          onKeyDown={(e) => e.key === 'Enter' && handleAnalyze((e.target as HTMLInputElement).value)}
        />
        <button 
          onClick={() => handleAnalyze('')} 
          disabled={isLoading}
          style={{ padding: '8px 16px', borderRadius: '4px', background: '#007bff', color: 'white', border: 'none', cursor: 'pointer' }}
        >
          {isLoading ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>

      {/* Error Overlay */}
      {error && (
        <div style={{ position: 'absolute', top: 80, right: 20, zIndex: 11, background: 'rgba(255,0,0,0.7)', color: 'white', padding: '10px', borderRadius: '4px', fontSize: '0.8rem' }}>
          Error: {error}
        </div>
      )}

      {/* Loading Overlay */}
      {isLoading && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'sans-serif' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="spinner" style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #3498db', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }}></div>
            <p>AI is analyzing the machine components...</p>
            <style>{` @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } } `}</style>
          </div>
        </div>
      )}
      
      <Viewer scene={scene} onPartSelect={setSelectedPart} />
      
      <PartInfo 
        part={selectedPart} 
        onClose={() => setSelectedPart(null)} 
      />
    </div>
  );
}

export default App;
