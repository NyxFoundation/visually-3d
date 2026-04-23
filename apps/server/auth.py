from fastapi import Header, HTTPException, Depends
from typing import Optional

async def get_current_user(authorization: Optional[str] = Header(None)):
    \"\"\"
    Validates the Claude session token or API key passed in the Authorization header.
    For MVP: Pass-through mechanism. If the header is present and starts with 'Bearer ', 
    we treat the remaining part as the token.
    \"\"\"
    if not authorization:
        raise HTTPException(
            status_code=401, 
            detail=\"Missing authorization header. Please provide a Claude API key.\"
        )
    
    if not authorization.startswith(\"Bearer \"):
        raise HTTPException(
            status_code=401, 
            detail=\"Invalid authorization header format. Expected 'Bearer <token>'\"
        )
    
    token = authorization.split(\" \")[1]
    
    if not token:
        raise HTTPException(
            status_code=401, 
            detail=\"Token not provided in authorization header.\"
        )
    
    # In a full implementation, we would verify the token with Anthropic's auth endpoint.
    # For the MVP pass-through, we simply return the token to be used in downstream API calls.
    return {\"token\": token}
