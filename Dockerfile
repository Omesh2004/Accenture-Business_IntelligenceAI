FROM python:3.11-slim

# Install system dependencies required for standard python networking/kafka libraries
RUN apt-get update && apt-get install -y \
    gcc \
    librdkafka-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Test tooling, off by default so production images stay lean:
#   docker compose build --build-arg INSTALL_DEV=1 ingestion-api
#
# `nodejs` is here for the same reason pytest is. Several regression guards execute the REAL Node
# taxonomy dialect via scripts/taxonomy_probe.js rather than reimplementing it -- a reimplementation
# is precisely how the three dialects drifted apart (CLAUDE.md coupling point 2). Without node on
# PATH those guards skip, and a skip reads as green: seven taxonomy and identity tests were passing
# by not running at all, including over source they were meant to police.
ARG INSTALL_DEV=0
RUN if [ "$INSTALL_DEV" = "1" ]; then       pip install --no-cache-dir -r requirements-dev.txt &&       apt-get update && apt-get install -y --no-install-recommends nodejs &&       rm -rf /var/lib/apt/lists/*;     fi

# Copy source code
COPY . .

# The actual command is overridden in docker-compose for each specific service
