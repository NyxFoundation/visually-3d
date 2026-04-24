import asyncio
import json
import shutil
from typing import Any, AsyncIterator, Dict, Optional

import httpx

SYSTEM_PROMPT = """You are a PhD Mechanical Engineer and 3D Scene Architect.
Analyze the provided URL or machine name and describe the machine's components.
Output ONLY a JSON object that strictly follows this TypeScript shape:
{
  "machine_name": string,
  "assembly_instructions"?: string,
  "metadata"?: object,
  "parts": [
    {
      "id": string,
      "name": string,
      "shape": "box" | "cylinder" | "sphere" | "complex",
      "position": [number, number, number],
      "size": number[],
      "material": string,
      "role": string,
      "connections"?: string[]
    }
  ]
}

Use these visualization heuristics:
1. Place antennas/sensors higher in the scene. Put heavy control units and power supplies lower/central.
2. Use boxes for chassis/control units/displays, cylinders for antennas/shafts, spheres for knobs/joints.
3. Encode signal flow in connections: sensor/antenna -> processor/control unit -> interface/display.
4. If mounted on a vehicle/truck, include a chassis or mounting plate base.
5. Keep dimensions plausible and non-zero. Use y as vertical height for Three.js.
"""


def claude_available() -> bool:
    return shutil.which("claude") is not None


async def fetch_url_content(url: str) -> str:
    """Fetch a small amount of URL content for Claude context."""
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            text = response.text
            return text[:12000]
    except Exception as exc:
        return f"Could not fetch URL content for {url}: {exc}"


async def build_prompt(url: Optional[str] = None, machine_name: Optional[str] = None) -> str:
    if url:
        content = await fetch_url_content(url)
        context = f"URL: {url}\nFetched content excerpt:\n{content}\n"
    elif machine_name:
        context = f"Machine name: {machine_name}\n"
    else:
        raise ValueError("Either url or machine_name must be provided")

    return f"{SYSTEM_PROMPT}\n\n{context}\nGenerate the MachineSceneDescriptor JSON now. Return JSON only."


def extract_json(text: str) -> Dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}") + 1
    if start < 0 or end <= start:
        raise ValueError("No JSON object found in Claude output")
    try:
        return json.loads(text[start:end])
    except json.JSONDecodeError as exc:
        raise ValueError(f"Claude returned invalid JSON: {exc}") from exc


async def stream_claude(prompt: str) -> AsyncIterator[Dict[str, Any]]:
    """Run the locally authenticated Claude CLI and yield structured stream events."""
    if not claude_available():
        raise RuntimeError(
            "claude command is not installed or not in PATH. Install Claude Code/CLI and run its login command first."
        )

    yield {"type": "log", "stream": "system", "message": "Starting local command: claude -p <prompt>"}
    process = await asyncio.create_subprocess_exec(
        "claude",
        "-p",
        prompt,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    output_chunks: list[str] = []
    queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()

    async def read_stream(stream: asyncio.StreamReader, name: str) -> None:
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode(errors="replace")
            if name == "stdout":
                output_chunks.append(text)
            await queue.put({"type": "log", "stream": name, "message": text})

    stdout_task = asyncio.create_task(read_stream(process.stdout, "stdout"))  # type: ignore[arg-type]
    stderr_task = asyncio.create_task(read_stream(process.stderr, "stderr"))  # type: ignore[arg-type]
    wait_task = asyncio.create_task(process.wait())

    while True:
        if wait_task.done() and queue.empty():
            break
        try:
            item = await asyncio.wait_for(queue.get(), timeout=0.1)
        except asyncio.TimeoutError:
            continue
        if item is not None:
            yield item

    await stdout_task
    await stderr_task
    return_code = await wait_task
    yield {"type": "log", "stream": "system", "message": f"claude exited with code {return_code}"}

    raw_output = "".join(output_chunks)
    if return_code != 0:
        raise RuntimeError(f"claude -p failed with exit code {return_code}")

    result = extract_json(raw_output)
    yield {"type": "result", "data": result}


async def analyze_machine(url: Optional[str] = None, machine_name: Optional[str] = None) -> Dict[str, Any]:
    prompt = await build_prompt(url=url, machine_name=machine_name)
    logs: list[str] = []
    async for event in stream_claude(prompt):
        if event["type"] == "log":
            logs.append(event.get("message", ""))
        elif event["type"] == "result":
            return event["data"]
    raise RuntimeError("Claude finished without returning a result")
