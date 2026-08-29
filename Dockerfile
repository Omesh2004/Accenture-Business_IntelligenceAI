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
ARG INSTALL_DEV=0
RUN if [ "$INSTALL_DEV" = "1" ]; then pip install --no-cache-dir -r requirements-dev.txt; fi

# Copy source code
COPY . .

# The actual command is overridden in docker-compose for each specific service
