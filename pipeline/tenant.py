"""Round 2 is one bank. `tenant_id` stays a COLUMN everywhere (the Signal Store determinism
story wants it, and it is cheap), but there is exactly one valid value."""
import os

TENANT = os.environ.get("PIPELINE_TENANT", "nexabank")
