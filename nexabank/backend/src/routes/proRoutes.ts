import express from "express";
import * as proController from "../controllers/proController";

const router = express.Router();

// All pro routes are already behind isLoggedIn via app.use("/api/pro", isLoggedIn, proRoutes)
// Do NOT add isLoggedIn here again — it causes double auth checks

// License management
router.post("/unlock", proController.unlockFeature as any);
router.get("/status", proController.getProStatus as any);

// Finance Library
router.post("/access_book", proController.accessBook as any);
router.post("/download_book", proController.downloadBook as any); // Legacy compat
router.get("/book_stats", proController.getBookStats as any);

// Crypto Trading
router.get("/crypto_prices", proController.getCryptoPrices as any);
router.post("/trade", proController.executeTrade as any);
router.get("/portfolio", proController.getPortfolio as any);

// Wealth Management
router.get("/wealth_insights", proController.getWealthInsights as any);
router.post("/rebalance_wealth", proController.rebalanceWealth as any);

// Payroll Pro
router.get("/payroll_payees", proController.getPayrollPayees as any);
router.post("/search_payees", proController.searchPayrollPayees as any);
router.post("/process_payroll", proController.processPayroll as any);

export default router;
