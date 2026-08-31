import sys
import os
import random
import time
from datetime import datetime, timedelta, timezone

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from warehouse.client import ch_client

TENANTS = ["safexbank", "nexabank"]
USERS_PER_TENANT = 50

def get_channel():
    return random.choices(["web", "mobile", "api"], weights=[0.6, 0.3, 0.1])[0]

def generate_events():
    events_to_send = []
    end_date = datetime.now(timezone.utc).replace(tzinfo=None)
    start_date = end_date - timedelta(days=7)
    delta_seconds = int((end_date - start_date).total_seconds())
    
    # 4 Pro features and some basic features
    features = [
        "login", "transfer_funds", "view_dashboard", 
        "pro-feature?id=crypto-trading", "wealth_rebalance", "pro-feature?id=bulk-payroll-processing", "pro_book_download"
    ]
    
    for tenant in TENANTS:
        users = [f"user_{i}" for i in range(USERS_PER_TENANT)]
        
        # Create about 300 events per tenant
        for _ in range(300):
            user = random.choice(users)
            feature = random.choice(features)
            
            random_seconds = random.randint(0, delta_seconds)
            event_time = start_date + timedelta(seconds=random_seconds)
            
            events_to_send.append({
                "event_name": feature,
                "tenant_id": tenant,
                "user_id": user,
                "timestamp": event_time.timestamp(),
                "channel": get_channel(),
                "metadata": {"ip": f"192.168.1.{random.randint(2, 254)}"}
            })
            
    # Sort chronologically
    events_to_send.sort(key=lambda x: x["timestamp"])
    return events_to_send

def main():
    print("Generating mock events for SafeXBank and NexaBank...")
    events = generate_events()
    print(f"Generated {len(events)} events. Inserting to ClickHouse...")
    
    try:
        ch_client.connect()
        ch_client.insert_events(events)
        print("Success! Inserted events for SafeXBank.")
    except Exception as e:
        print(f"Error inserting events: {e}")

if __name__ == "__main__":
    main()
