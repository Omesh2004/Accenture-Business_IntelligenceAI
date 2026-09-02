from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Kafka
    KAFKA_BROKER_URL: str = "broker:29092"
    KAFKA_TOPIC_EVENTS: str = "feature-events"

    # ClickHouse. The warehouse is three databases (bronze / silver / gold); every query names
    # its own, so this is only the client's connection default and must always exist.
    CLICKHOUSE_HOST: str = "clickhouse"
    CLICKHOUSE_PORT: int = 8123
    CLICKHOUSE_USER: str = "default"
    CLICKHOUSE_PASSWORD: str = ""
    CLICKHOUSE_DATABASE: str = "default"

    # LLM serving (small, local, on-prem — vLLM). Ollama is only a starting fallback.
    HF_TOKEN: str = ""
    VLLM_URL: str = "http://vllm-server:8000/v1"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
