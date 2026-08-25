import clickhouse_connect
import logging
import time
import json
from typing import List, Dict, Any
import os
import sys
from datetime import datetime

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.config import settings

logger = logging.getLogger(__name__)

class ClickHouseClient:
    def __init__(self):
        self.client = None

    def _get_client(self):
        """Get a fresh ClickHouse client for thread-safe concurrent queries."""
        return clickhouse_connect.get_client(
            host=settings.CLICKHOUSE_HOST,
            port=settings.CLICKHOUSE_PORT,
            username=settings.CLICKHOUSE_USER,
            password=settings.CLICKHOUSE_PASSWORD,
            database=settings.CLICKHOUSE_DATABASE
        )

    def connect(self, retries=5):
        """Establish connection to ClickHouse, retrying if necessary."""
        for i in range(retries):
            try:
                self.client = self._get_client()
                logger.info("Connected to ClickHouse successfully.")
                return
            except Exception as e:
                logger.warning(f"Failed to connect to ClickHouse (Attempt {i+1}/{retries}): {e}")
                time.sleep(2)
        
        raise ConnectionError("Could not connect to ClickHouse after retries.")

    def insert_events(self, events: List[Dict[str, Any]]):
        """Bulk insert raw events into ClickHouse."""
        client = self._get_client()
            
        if not events:
            return

        # Prepare column data
        data = [
            [
                e.get('event_id', ''),
                e.get('session_id') or e.get('metadata', {}).get('session_id', ''),
                e['tenant_id'], 
                e['event_name'], 
                e['user_id'], 
                e['channel'], 
                datetime.utcfromtimestamp(e['timestamp']), 
                json.dumps(e.get('metadata', {}), ensure_ascii=True) # Encode as valid JSON
            ]
            for e in events
        ]
        
        client.insert(
            'feature_intelligence.events_raw',
            data,
            column_names=['event_id', 'session_id', 'tenant_id', 'event_name', 'user_id', 'channel', 'timestamp', 'metadata']
        )
        logger.debug(f"Inserted {len(events)} events into ClickHouse.")

    def query(self, sql: str, parameters: dict = None) -> List[Dict[str, Any]]:
        """Execute a custom SQL query and return dicts. Creates a fresh client per call for thread safety."""
        client = self._get_client()
            
        result = client.query(sql, parameters=parameters if parameters else {})
        
        # Zip column names with row values
        columns = result.column_names
        rows = result.result_rows
        
        return [dict(zip(columns, row)) for row in rows]

# Singleton instance
ch_client = ClickHouseClient()
