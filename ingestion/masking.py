import re
from typing import Dict, Any

# Simple regex patterns for PII detection
EMAIL_REGEX = re.compile(r"[\w\.-]+@[\w\.-]+\.\w+")
IP_REGEX = re.compile(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b")

def mask_pii(text: str) -> str:
    """Masks basic PII like emails and IPv4 addresses in strings."""
    if not isinstance(text, str):
        return text
    
    text = EMAIL_REGEX.sub("[REDACTED_EMAIL]", text)
    text = IP_REGEX.sub("[REDACTED_IP]", text)
    return text

def sanitize_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively traverses metadata and sanitizes PII strings."""
    sanitized = {}
    for key, value in metadata.items():
        if isinstance(value, str):
            sanitized[key] = mask_pii(value)
        elif isinstance(value, dict):
            sanitized[key] = sanitize_metadata(value)
        elif isinstance(value, list):
            sanitized[key] = [sanitize_metadata(item) if isinstance(item, dict) else mask_pii(item) if isinstance(item, str) else item for item in value]
        else:
            sanitized[key] = value
    return sanitized
