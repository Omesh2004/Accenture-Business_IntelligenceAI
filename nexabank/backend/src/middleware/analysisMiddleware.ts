import { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";

/**
 * Analysis Middleware: Intercepts loan applications and logs data for external analysis.
 * In a real-world scenario, this might POST to a specialized API or a message queue.
 */
export const analysisMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Only process POST requests to loan application routes
  if (req.method === "POST" && req.path.includes("apply")) {
    const analysisData = {
      timestamp: new Date().toISOString(),
      customerId: req.body.customerId,
      loanDetails: {
        type: req.body.loanType,
        amount: req.body.principalAmount,
        term: req.body.term,
      },
      kycProvided: !!req.body.kycData,
      metadata: {
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      }
    };

    console.log("[ANALYSIS_LOG] New Loan Application Intercepted:", JSON.stringify(analysisData, null, 2));

    // Persist to a local file for later consumption by the analysis tool
    const logFilePath = path.join(__dirname, "../../analysis_logs.json");
    try {
      let logs = [];
      if (fs.existsSync(logFilePath)) {
        const data = fs.readFileSync(logFilePath, "utf8");
        logs = JSON.parse(data);
      }
      logs.push(analysisData);
      fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2));
    } catch (err) {
      console.error("[ANALYSIS_ERROR] Failed to save analysis log:", err);
    }
  }
  
  next();
};
