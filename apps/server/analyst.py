import os
import json
import httpx
import anthropic
from typing import Optional, Dict, Any

# Load API key from environment
ANTHROPIC_API_KEY=os.getenv("ANTHROPIC_API_KEY")

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

SYSTEM_PROMPT = (
    "You are a PhD Mechanical Engineer and 3D Scene Architect. "
    "Analyze the provided URL or machine name and describe the machine's components. "
    "Output ONLY a JSON object that strictly follows the schema in shared/schema.json. "
    "Estimate 3D coordinates [x,y,z] and sizes [w,h,d] to create a plausible spatial representation. "
    "The output must be a valid JSON object and nothing else.\n\n"
    "Heuristics for Machinery Visualization:\n"
    "1. Spatial Logic: Sensors and Antennas are typically positioned higher up (higher Z axis) to maximize range/coverage. "
    "Main control units, processing boxes, and power supplies are usually central or lower-mounted for stability. \n"
    "2. Component Geometry:\n"
    "- Antennas: Usually tall cylinders (height > width) or thin boxes.\n"
    "- Control Units/Processors: Rectangular boxes (box shape).\n"
    "- Mounting Structures (e.g., vehicle chassis): Large flat bases or complex boxes.\n"
    "3. Logical Connectivity: Follow the signal flow: Sensor/Antenna -> Processor/Control Unit -> Interface/Display. "
    "Ensure 'connections' in the JSON reflect this logical flow.\n"
    "4. Vehicle-Mounted Devices: If the device is described as being on a truck or vehicle, include a base 'Chassis' or 'Mounting Plate' as a part and position other components relative to it."
)

async def fetch_url_content(url: str) -> str:
    \"\"\"Fetches the content of a URL to provide context to the AI.\"\"\"
    try:
        async with httpx.AsyncClient(timeout=10.0) as async_client:
            response = await async_client.get(url)
            response.raise_for_status()
            # Basic extraction of text from HTML/Content
            return response.text[:10000] # Limit characters to avoid token overflow
    except Exception as e:
        return f"Error fetching URL {url}: {str(e)}"

async def analyze_machine(url: Optional[str] = None, machine_name: Optional[str] = None) -> Dict[str, Any]:
    \"\"\"
    Analyzes a machine based on a URL or name using Claude-3.5-Sonnet.
    \"\"\"
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY environment variable is not set")

    prompt_context = ""
    if url:
        content = await fetch_url_content(url)
        prompt_context = f"URL Provided: {url}\nContent Summary: {content}\n\n"
    elif machine_name:
        prompt_context = f"Machine Name Provided: {machine_name}\n\n"
    else:
        raise ValueError("Either url or machine_name must be provided")

    user_message = f"{prompt_context}Please generate the MachineSceneDescriptor JSON for this machine."

    response = client.messages.create(
        model="claude-3-5-sonnet-20240620",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[
            {"role": "user", "content": user_message}
        ]
    )

    # Extract the text content from the response
    text_content = response.content[0].text
    
    # Attempt to parse JSON from the response
    try:
        # Find first '{' and last '}' in case there's preamble
        start_idx = text_content.find('{')
        end_idx = text_content.rfind('}') + 1
        if start_idx == -1 or end_idx == 0:
            raise ValueError("No JSON object found in AI response")
        
        json_str = text_content[start_idx:end_idx]
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        raise ValueError(f"AI returned invalid JSON: {str(e)}")
