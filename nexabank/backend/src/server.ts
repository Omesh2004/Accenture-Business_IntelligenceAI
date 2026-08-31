import dotenv from "dotenv";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import app from "./app";
import { prisma } from "./prisma";

dotenv.config({ path: [".env.local", ".env"] });

const PORT: number = parseInt(process.env.PORT || "5000", 10);

const server = http.createServer(app);

// ═══════════════════════════════════════════════════════════════
// ─── WebSocket Server ─────────────────────────────────────────
// Broadcasts NexaBank events (transactions, loans, simulation)
// to connected clients for real-time dashboard updates.
// ═══════════════════════════════════════════════════════════════

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });

  // Send initial ping
  ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
});

/**
 * Broadcast a JSON event to all connected WebSocket clients.
 * Fire-and-forget — failures are silently ignored.
 */
export function broadcastEvent(eventType: string, data: Record<string, any>): void {
  const payload = JSON.stringify({ type: eventType, data, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        // ignore send errors
      }
    }
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server running on ws://localhost:${PORT}/ws`);
  console.log(`📦 Environment: ${process.env.NODE_ENV ?? "development"}`);
});

server.on("error", (error: Error) => {
  console.error("Server error:", error);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  console.log("\n🔄 Shutting down gracefully...");
  wss.close(() => {
    console.log("✅ WebSocket server closed");
  });
  server.close(() => {
    console.log("✅ HTTP server closed");
  });
  await prisma.$disconnect();
  console.log("✅ Database disconnected");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
