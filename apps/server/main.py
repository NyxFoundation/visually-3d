from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Optional, Union

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
async def analyze(request: AnalyzeRequest):
    """
    Mock endpoint to analyze a machine via URL or name.
    Returns a mock response adhering to the MachineSceneDescriptor schema.
    """
    # Identify what we are analyzing
    target = request.url or request.machine_name or "Unknown Machine"
    
    # Mock Response Data
    mock_response = MachineSceneDescriptor(
        machine_name=f"Mock Machine ({target})",
        assembly_instructions="This is a mock assembly instruction for testing the FastAPI skeleton.",
        metadata={"version": "1.0-mock", "generated_by": "FastAPI-Skeleton"},
        parts=[
            Part(
                id="part_001",
                name="Base Plate",
                shape="box",
                position=[0.0, 0.0, 0.0],
                size=[10.0, 1.0, 10.0],
                material="Steel",
                role="Provides the foundation for the machine."
            ),
            Part(
                id="part_002",
                name="Main Shaft",
                shape="cylinder",
                position=[0.0, 5.0, 0.0],
                size=[0.5, 10.0],
                material="Chrome",
                role="Rotates to drive the internal mechanism.",
                connections=["part_001"]
            ),
            Part(
                id="part_003",
                name="Control Knob",
                shape="sphere",
                position=[0.0, 11.0, 0.0],
                size=[0.3],
                material="Plastic",
                role="Allows user to adjust rotation speed.",
                connections=["part_002"]
            )
        ]
    )
    
    return mock_response
