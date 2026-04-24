import json
from typing import Any, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:
    from .analyst import analyze_machine, build_prompt, claude_available, stream_claude
except ImportError:  # Allows `uvicorn main:app` from apps/server during development.
    from analyst import analyze_machine, build_prompt, claude_available, stream_claude


app = FastAPI(title="Visually Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Part(BaseModel):
    id: str = Field(..., description="Unique identifier for the part.")
    name: str = Field(..., description="Descriptive name of the part.")
    shape: str = Field(..., description="Geometry type: box, cylinder, sphere, or complex.")
    position: List[float] = Field(..., min_length=3, max_length=3, description="[x, y, z] coordinates.")
    size: List[float] = Field(..., min_length=1, description="Dimensions based on shape.")
    material: str = Field(..., description="Material type or visual description.")
    role: str = Field(..., description="Functional explanation.")
    connections: List[str] = Field(default_factory=list, description="Connected part IDs.")


class MachineSceneDescriptor(BaseModel):
    machine_name: str
    assembly_instructions: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    parts: List[Part]


class AnalyzeRequest(BaseModel):
    url: Optional[str] = None
    machine_name: Optional[str] = None


@app.get("/")
async def root():
    return {
        "status": "healthy",
        "message": "Visually Backend is running",
        "claude_cli_available": claude_available(),
        "auth_mode": "local claude CLI via `claude -p`",
    }


@app.post("/analyze", response_model=MachineSceneDescriptor)
async def analyze(request: AnalyzeRequest):
    try:
        result = await analyze_machine(url=request.url, machine_name=request.machine_name)
        return MachineSceneDescriptor(**result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {exc}") from exc


@app.post("/analyze/stream")
async def analyze_stream(request: AnalyzeRequest):
    async def event_generator():
        try:
            prompt = await build_prompt(url=request.url, machine_name=request.machine_name)
            async for event in stream_claude(prompt):
                yield f"event: {event['type']}\n"
                yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
        except Exception as exc:
            payload = {"type": "error", "message": str(exc)}
            yield "event: error\n"
            yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")
