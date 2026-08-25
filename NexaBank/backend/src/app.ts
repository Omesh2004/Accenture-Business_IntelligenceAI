import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import userRoutes from "./routes/userRoutes";
import accountRoutes from "./routes/accountRoutes";
import transactionRoutes from "./routes/transactionRoutes";
import loanRoutes from "./routes/loanRoutes";
import eventRoutes from "./routes/eventRoutes";
import tenantRoutes from "./routes/tenantRoutes";
import proRoutes from "./routes/proRoutes";
import { isLoggedIn } from "./middleware/IsLoggedIn";
import { apiTrackingMiddleware, requestTelemetryMiddleware } from "./middleware/eventTracker";

const app: Application = express();

// Middleware
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        process.env.FRONTEND_URL
      ];
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(helmet());
app.use(morgan("dev"));
app.use(cookieParser());
app.use(requestTelemetryMiddleware);

// Global API Tracking Middleware
app.use(apiTrackingMiddleware);

// Routes
app.use("/api", userRoutes);
app.use("/api", eventRoutes);
app.use("/api/pro", isLoggedIn, proRoutes);
app.use("/api", isLoggedIn, accountRoutes);
app.use("/api", isLoggedIn, transactionRoutes);
app.use("/api", isLoggedIn, loanRoutes);
app.use("/api", isLoggedIn, tenantRoutes);

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", message: "NexaBank API is running" });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

export default app;
