import React from 'react';
import { Viewer } from './components/Viewer';

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
  return (
    <div className="app-container">
      <div style={{ position: 'absolute', top: 20, left: 20, color: 'white', zIndex: 10, pointerEvents: 'none', fontFamily: 'sans-serif' }}>
        <h1>{MOCK_SCENE.machine_name}</h1>
        <p>3D Visualization Preview</p>
      </div>
      <Viewer scene={MOCK_SCENE} />
    </div>
  );
}

export default App;
