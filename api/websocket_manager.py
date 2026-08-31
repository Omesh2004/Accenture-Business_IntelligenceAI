import asyncio
import json
import uuid
import logging
from typing import Dict, Set
from fastapi import WebSocket
from aiokafka import AIOKafkaConsumer

from warehouse.config import settings

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, tenant_id: str):
        await websocket.accept()
        if tenant_id not in self.active_connections:
            self.active_connections[tenant_id] = set()
        self.active_connections[tenant_id].add(websocket)
        logger.info(f"WebSocket connected for tenant: {tenant_id}")

    def disconnect(self, websocket: WebSocket, tenant_id: str):
        if tenant_id in self.active_connections:
            self.active_connections[tenant_id].discard(websocket)
            if not self.active_connections[tenant_id]:
                del self.active_connections[tenant_id]
        logger.info(f"WebSocket disconnected for tenant: {tenant_id}")

    async def broadcast_to_tenant(self, tenant_id: str, message: dict):
        connections = self.active_connections.get(tenant_id)
        if not connections:
            return

        # I3: iterate a SNAPSHOT. Holding a live reference and awaiting inside the loop
        # means a concurrent connect() raises "Set changed size during iteration".
        dead_sockets = set()
        for connection in list(connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead_sockets.add(connection)

        for dead in dead_sockets:
            self.disconnect(dead, tenant_id)

manager = ConnectionManager()

async def consume_kafka_events():
    """Reads from Kafka in real-time and pushes simple events (Option B)."""
    kafka_url = getattr(settings, "KAFKA_BROKER_URL", "broker:29092")
    topic = getattr(settings, "KAFKA_TOPIC_EVENTS", "feature-events")
    
    # Simple retry block since Kafka might not be ready immediately
    consumer = None
    for _ in range(5):
        try:
            # I5: a SHARED group id makes two API replicas split the partitions, so a
            # browser on replica A never sees events landing on B's. This is a fanout consumer,
            # not a work queue -- every process needs its own group.
            consumer = AIOKafkaConsumer(
                topic,
                bootstrap_servers=kafka_url,
                group_id=f"websocket-broadcaster-{uuid.uuid4().hex[:8]}",
                auto_offset_reset="latest"
            )
            await consumer.start()
            break
        except Exception as e:
            logger.warning(f"Kafka consumer connection failed, retrying... {e}")
            await asyncio.sleep(5)
            
    if not consumer:
        logger.error("Failed to connect to Kafka for WebSockets.")
        return

    try:
        async for msg in consumer:
            try:
                if not manager.active_connections:
                    continue

                event = json.loads(msg.value.decode('utf-8'))
                tenant_id = event.get("tenant_id")

                # Connections are keyed by tenant_id, so fan-out is O(1).
                if tenant_id:
                    # API-10: broadcast a SUMMARY, not the raw payload. The socket is
                    # unauthenticated at the middleware layer, and the raw event carries
                    # user_id and full metadata.
                    await manager.broadcast_to_tenant(tenant_id, {
                        "type": "REALTIME_EVENT",
                        "payload": {
                            "event_name": event.get("event_name"),
                            "channel": event.get("channel"),
                            "timestamp": event.get("timestamp"),
                            "tenant_id": tenant_id,
                        },
                    })
            except json.JSONDecodeError:
                continue
    finally:
        await consumer.stop()

async def poll_dashboard_metrics():
    """Polls ClickHouse every 10 seconds and pushes metrics (Option A)."""
    # Import needed metrics query functions
    from api.main import get_kpi_metrics, get_realtime_users
    
    while True:
        await asyncio.sleep(10)
        loop = asyncio.get_event_loop()
        
        tenants_to_update = list(manager.active_connections.keys())
        for tenant_id in tenants_to_update:
            try:
                # Wrap sync database calls in executor to avoid blocking the event loop
                # IMPORTANT: pass "7d" explicitly as string
                kpi = await loop.run_in_executor(None, get_kpi_metrics, tenant_id, "7d")
                rt_data = await loop.run_in_executor(None, get_realtime_users, tenant_id)
                # get_realtime_users now returns {count, timestamp_ist, timezone}
                rt_count = rt_data.get("count", 0) if isinstance(rt_data, dict) else rt_data
                
                payload = {
                    "type": "METRICS_UPDATE",
                    "payload": {
                        "kpiMetrics": kpi,
                        "realtimeUsers": rt_count
                    }
                }
                await manager.broadcast_to_tenant(tenant_id, payload)
                
            except Exception as e:
                logger.error(f"Error polling metrics for tenant {tenant_id}: {e}")

async def start_websocket_background_tasks():
    # Execute both real-time kafka listening and interval DB polling
    asyncio.create_task(consume_kafka_events())
    asyncio.create_task(poll_dashboard_metrics())
