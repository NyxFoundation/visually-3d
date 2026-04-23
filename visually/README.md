# visually - 3D Machinery Visualization & Learning Platform

A platform that transforms machine blueprints or names into interactive 3D visualizations, allowing users to explore part compositions, connectivity, and the functional roles of components.

## 🚀 Vision
The goal is to bridge the gap between 2D technical documentation (blueprints/text) and conceptual understanding through an AI-driven 3D experience.

## 🛠 Technical Architecture

### 1. Core Stack
- **Frontend**: React + Three.js (React Three Fiber / Drei) for 3D rendering.
- **Backend**: FastAPI (Python) to orchestrate AI agents for blueprint analysis.
- **AI Engine**: Claude (Anthropic) for interpreting blueprints and generating 3D scene descriptors (JSON/GLTF metadata).
- **Auth**: Claude Auth Integration (OAuth2/Session-based) to allow users to utilize their own Claude accounts.
- **Rendering**: WebGL via Three.js, supporting click-to-inspect interactivity.

### 2. Workflow
`User Input (URL/Name)` $\rightarrow$ `AI Blueprint Analyst (Claude)` $\rightarrow$ `3D Scene Descriptor (JSON)` $\rightarrow$ `Client-side 3D Generation (Three.js)` $\rightarrow$ `Interactive Learning Experience`.

## 📋 Requirements & Features

### Functional Requirements
- **Input Handling**: Support for URLs (PDF/Image/Blog) and machine names.
- **AI Analysis**: Extract structural data: parts list, connectivity, material, and role of each part.
- **3D Visualization**: 
  - Procedural generation of simplified 3D geometry based on AI analysis.
  - Interactive highlights on click.
  - "Exploded view" animation to show internal connectivity.
- **Educational Overlay**: Side-panel showing detailed part information (material, role, and how it connects to others).
- **Authentication**: Integration with Claude account for personalized AI processing.

### Non-Functional Requirements
- **Performance**: Smooth 60fps 3D interaction.
- **Accuracy**: High fidelity in representing mechanical logical connections.
- **Security**: Secure handling of auth tokens.

## 📂 Project Structure
```text
visually/
├── apps/
│   ├── web/              # Three.js / React Frontend
│   └── server/           # FastAPI / AI Orchestrator
├── docs/
│   ├── designs/          # Architectural diagrams
│   └── plans/            # Implementation plans
└── shared/               # Types and shared schemas (JSON descriptors)
```
