# Implementation Plan: MVP for visually

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a functioning prototype that can take a machine name/URL, analyze its structure via Claude, and render a basic interactive 3D scene with part-level details.

**Architecture:**
- **Frontend**: React + @react-three/fiber (R3F) + Tailwind CSS.
- **Backend**: FastAPI.
- **AI Logic**: Claude-3.5-Sonnet for structural analysis $\rightarrow$ JSON scene descriptor.
- **Auth**: Claude-based authentication mock/integration.

**Tech Stack**: React, Three.js, FastAPI, Python, Claude API.

---

### Phase 1: Foundation & API Design

#### Task 1: Define the 3D Scene Descriptor Schema
**Objective:** Create a standardized JSON format that the AI will output to describe a machine.
**Files:** Create `shared/schema.json`
**Spec:**
- `machine_name`: string
- `parts`: array of objects { `id`, `name`, `shape` (box/cylinder/sphere), `position` [x,y,z], `size` [w,h,d], `material`, `role`, `connections`: [`part_id`] }
- `assembly_instructions`: string (for the learner)

#### Task 2: Setup FastAPI Backend Skeleton
**Objective:** Basic API to receive input and return a mock scene.
**Files:** Create `apps/server/main.py`
**Endpoints:** `POST /analyze` (takes URL/Name, returns Scene Descriptor).

---

### Phase 2: AI Integration (The Core)

#### Task 3: Implement AI Analysis Pipeline (The "Analyst")
**Objective:** Integrate Claude to turn a URL/Name into the `schema.json` format.
**Files:** Modify `apps/server/main.py`, create `apps/server/analyst.py`.
**Logic:** Use a system prompt that forces the AI to behave as a mechanical engineer, simulating a 3D coordinate system for the parts.

#### Task 4: Claude Auth Integration
**Objective:** Implement the authentication flow allowing users to use their Claude account.
**Files:** `apps/server/auth.py`, `apps/web/src/auth.tsx`.

---

### Phase 3: 3D Frontend Visualization

#### Task 5: Basic 3D Viewer Setup
**Objective:** Render a 3D canvas that can read the JSON descriptor and draw primitive shapes.
**Files:** `apps/web/src/components/Viewer.tsx`
**Features:** Basic orbit controls, lighting.

#### Task 6: Interactive Part Inspection
**Objective:** Add `onClick` handlers to 3D objects to trigger a side-panel with `role` and `material` info.
**Files:** `apps/web/src/components/Viewer.tsx`, `apps/web/src/components/PartInfo.tsx`.

#### Task 7: Connectivity Visualization
**Objective:** Draw lines between parts based on the `connections` field in the schema.
**Files:** `apps/web/src/components/Connections.tsx`.

---

### Phase 4: Demo Case (Electromagnetic Interference Detection Equipment)

#### Task 8: Tune AI Prompt for the Demo Case
**Objective:** Ensure the AI can correctly analyze the provided blog post URL and represent the "電磁妨害状況把握装置" (Interference Detection Equipment) accurately.
**Files:** `apps/server/analyst.py` (Prompt tuning).

#### Task 9: Final Integration & Polish
**Objective:** End-to-end test from URL input to 3D visualization.
**Files:** All.

---

**Verification Step:** 
1. Input the URL: `https://jm2040.blogspot.com/2021/07/blog-post.html`
2. System generates a 3D scene showing the antenna arrays, processing units, and truck-mounted chassis.
3. User clicks on the antenna $\rightarrow$ "Senses electromagnetic interference from satellites" is displayed.
