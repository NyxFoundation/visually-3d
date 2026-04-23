from fastapi import FastAPI, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import List, Optional, Union
from .analyst import analyze_machine
from .auth import get_current_user


app = FastAPI(title="Visually Backend")

# --- Schemas based on shared/schema.json ---

class Part(BaseModel):
    id: str = Field(..., description="Unique identifier for the part.")
    name: str = Field(..., description="Descriptive name of the part.")
    shape: str = Field(..., description="The geometry type of the part. (box, cylinder, sphere, complex)")
    position: List[float] = Field(..., min_items=3, max_items=3, description="[x, y, z] coordinates.")
    size: List[float] = Field(..., min_items=1, description="Dimensions based on shape.")
    material: str = Field(..., description="Material type or visual description of the part.")
    role: str = Field(..., description="Functional explanation of what this part does in the machine.")
    connections: Optional[List[str]] = Field(default=[], description="List of part IDs that this part is connected to.")

class MachineSceneDescriptor(BaseModel):
    machine_name: str = Field(..., description="The name of the machine being described.")
    assembly_instructions: Optional[str] = Field(None, description="General description of how the machine is put together.")
    metadata: Optional[dict] = Field(None, description="Any extra information related to the machine.")
    parts: List[Part] = Field(..., description="A list of parts that make up the machine.")

class AnalyzeRequest(BaseModel):
    url: Optional[str] = None
    machine_name: Optional[str] = None

# --- Endpoints ---

@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "healthy", "message": "Visually Backend is running"}

@app.post("/analyze", response_model=MachineSceneDescriptor)
async def analyze(request: AnalyzeRequest, user=Depends(get_current_user)):
    """
    Analyze a machine via URL or name using the AI analysis pipeline.
    """
    try:
        # Pass the user token to the analysis pipeline
        result = await analyze_machine(url=request.url, machine_name=request.machine_name, token=user["token"])
        return MachineSceneDescriptor(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")
