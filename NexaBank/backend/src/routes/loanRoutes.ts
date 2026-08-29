import { Prisma, LoanType, ApplicationStatus } from "@prisma/client";
import express, { Request, Response } from "express";
import { prisma } from "../prisma";
import { analysisMiddleware } from "../middleware/analysisMiddleware";
import { trackEvent } from "../middleware/eventTracker";
import { isAdmin, isLoggedIn } from "../middleware/IsLoggedIn";

const router = express.Router();

// GET all loans
router.get(
  "/loans",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const loans = await prisma.loan.findMany({
        orderBy: { createdOn: "desc" },
        include: { Account: true }
      });
      res.status(200).json(loans);
    } catch (error) {
      console.error("Error fetching loans:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// GET all loan applications for a user
router.get(
  "/applications/:userId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const applications = await prisma.loanApplication.findMany({
        where: { customerId: userId },
        orderBy: { createdOn: "desc" },
      });
      res.status(200).json(applications);
    } catch (error) {
      console.error("Error fetching applications:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// GET all loan applications (Admin only)
router.get(
  "/admin/applications",
  isLoggedIn,
  isAdmin,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const applications = await prisma.loanApplication.findMany({
        orderBy: { createdOn: "desc" },
        include: {
          customer: {
            select: { name: true, email: true, phone: true }
          }
        }
      });
      res.status(200).json(applications);
    } catch (error) {
      console.error("Error fetching all applications for admin:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// POST — Submit a new loan application (with analysis middleware)
router.post(
  "/apply",
  analysisMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        customerId,
        loanType,
        principalAmount,
        term,
        interestRate,
        kycData
      } = req.body as {
        customerId: string;
        loanType: LoanType;
        principalAmount: number;
        term: number;
        interestRate: number;
        kycData: any;
      };

      if (!customerId || !loanType || !principalAmount || !term) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      const application = await prisma.loanApplication.create({
        data: {
          customerId,
          loanType,
          principalAmount,
          term,
          interestRate,
          status: "PENDING",
          kycData: kycData || {},
        },
      });

      const tenantId = (req as any).user?.tenantId ?? "bank_a";
      await trackEvent("loan_applied", customerId, tenantId, { loanType, amount: principalAmount, term });

      res.status(201).json({
        message: "Application submitted successfully",
        application
      });
    } catch (error) {
      console.error("Loan application error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST — Approve a loan application (converts to active Loan)
router.post(
  "/approve/:applicationId",
  isLoggedIn,
  isAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { applicationId } = req.params;
      const { accNo } = req.body; // Target account for disbursal

      if (!accNo) {
        res.status(400).json({ error: "Account number required for disbursal" });
        return;
      }

      // Verify target account exists
      const targetAccount = await prisma.account.findUnique({ where: { accNo } });
      if (!targetAccount) {
        res.status(400).json({ error: "Target account for disbursal not found" });
        return;
      }

      const app = await prisma.loanApplication.findUnique({
        where: { id: applicationId }
      });

      if (!app || app.status !== "PENDING") {
        res.status(404).json({ error: "Valid pending application not found" });
        return;
      }

      const customer = await prisma.customer.findUnique({
        where: { id: app.customerId },
        include: { tenant: true }
      });

      if (!customer || !customer.tenant) {
        res.status(404).json({ error: "Customer or Tenant not found" });
        return;
      }

      // Start transaction: update app status and create active loan
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updatedApp = await tx.loanApplication.update({
          where: { id: applicationId },
          data: { status: "APPROVED" }
        });

        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(startDate.getMonth() + app.term);

        const activeLoan = await tx.loan.create({
          data: {
            accNo,
            loanType: app.loanType,
            principalAmount: app.principalAmount,
            interestRate: app.interestRate,
            interestAmount: (app.principalAmount * app.interestRate * (app.term / 12)) / 100,
            term: app.term,
            startDate,
            endDate,
            status: "ACTIVE",
            dueAmount: app.principalAmount, // Simplified
            schedule: []
          }
        });

        // Disburse funds to account
        await tx.account.update({
          where: { accNo },
          data: { balance: { increment: app.principalAmount } }
        });

        // Create Transaction Record
        const loanRef = activeLoan.id.slice(0, 4).toUpperCase();

        await tx.transaction.create({
          data: {
            transactionType: "TRANSFER",
            senderAccNo: "NEXABANK-SYSTEM",
            receiverAccNo: accNo,
            amount: app.principalAmount,
            status: "SUCCESS",
            category: "LOAN_DISBURSAL",
            description: `${app.loanType} Loan Disbursal (${loanRef})`,
            loanId: activeLoan.id,
          }
        });

        return { updatedApp, activeLoan, customerId: app.customerId };
      });

      await trackEvent("loan_approved", result.customerId, customer?.tenantId || "bank_a", { applicationId, loanId: result.activeLoan.id });

      res.status(200).json(result);
    } catch (error) {
      console.error("Approval error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST — Reject a loan application
router.post(
  "/reject/:applicationId",
  isLoggedIn,
  isAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { applicationId } = req.params;

      const app = await prisma.loanApplication.findUnique({
        where: { id: applicationId }
      });

      if (!app || app.status !== "PENDING") {
        res.status(404).json({ error: "Valid pending application not found" });
        return;
      }

      const updatedApp = await prisma.loanApplication.update({
        where: { id: applicationId },
        data: { status: "REJECTED" }
      });

      const customer = await prisma.customer.findUnique({
        where: { id: app.customerId },
        select: { tenantId: true },
      });

      await trackEvent("loan_rejected", app.customerId, customer?.tenantId || "bank_a", { applicationId });

      res.status(200).json({ message: "Application rejected", application: updatedApp });
    } catch (error) {
      console.error("Rejection error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET loan by ID
router.get(
  "/loanbyId/:id",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const loan = await prisma.loan.findUnique({
        where: { id },
        include: {
          Account: true,
          payment: true,
        },
      });

      if (!loan) {
        res.status(404).json({ error: "Loan not found" });
        return;
      }

      res.status(200).json(loan);
    } catch (error) {
      console.error("Error fetching loan:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// PUT — Update KYC Data/Step
router.put(
  "/applications/:id/kyc",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { kycData, kycStep } = req.body;

      const app = await prisma.loanApplication.findUnique({
        where: { id }
      });

      if (!app) {
        res.status(404).json({ error: "Application not found" });
        return;
      }

      const updatedApp = await prisma.loanApplication.update({
        where: { id },
        data: {
          kycData: kycData ? { ...(app.kycData as object), ...kycData } : app.kycData,
          kycStep: kycStep ?? app.kycStep,
        }
      });

      const customer = await prisma.customer.findUnique({
        where: { id: app.customerId },
      });

      // Track milestone based on step size
      if (kycStep === 3) {
        await trackEvent("kyc_completed", app.customerId, customer?.tenantId || "bank_a", { applicationId: id });
      }

      res.status(200).json(updatedApp);
    } catch (error) {
      console.error("KYC update error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

export default router;
