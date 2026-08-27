import { Prisma } from "@prisma/client";
import express, { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { trackEvent } from "../middleware/eventTracker";

const router = express.Router();

// GET all transactions
router.get("/transactions", async (_req: Request, res: Response): Promise<void> => {
  try {
    const trans = await prisma.transaction.findMany({
      orderBy: { timestamp: "desc" },
    });
    res.status(200).json(trans);
  } catch (error) {
    console.error("Transaction error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET transactions by receiver account number
router.get(
  "/byReceiverAccTransactions/:ReceiverAcc",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { ReceiverAcc } = req.params;
      if (!ReceiverAcc) {
        res.status(400).json({ error: "Receiver Account Number is required" });
        return;
      }

      const transactions = await prisma.transaction.findMany({
        where: { receiverAccNo: ReceiverAcc },
        include: {
          senderAccount: true,
          receiverAccount: true,
          loan: true,
        },
      });

      res.status(200).json(transactions);
    } catch (error) {
      console.error("Transaction error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// GET transaction by ID
router.get(
  "/byIdTransactions/:id",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const transaction = await prisma.transaction.findUnique({
        where: { id },
        include: {
          senderAccount: true,
          receiverAccount: true,
          loan: true,
        },
      });

      if (!transaction) {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      res.status(200).json(transaction);
    } catch (error) {
      console.error("Transaction error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// GET transactions by sender account number
router.get(
  "/bySenderAccTransactions/:SenderAcc",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { SenderAcc } = req.params;
      if (!SenderAcc) {
        res.status(400).json({ error: "Sender Account Number is required" });
        return;
      }

      const transactions = await prisma.transaction.findMany({
        where: { senderAccNo: SenderAcc },
        include: {
          senderAccount: true,
          receiverAccount: true,
          loan: true,
        },
      });

      res.status(200).json(transactions);
    } catch (error) {
      console.error("Transaction error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// GET transactions by user account (sender OR receiver)
router.get(
  "/byUserAcc/:Acc",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { Acc } = req.params;
      if (!Acc) {
        res.status(400).json({ error: "Account Number is required" });
        return;
      }

      const transactions = await prisma.transaction.findMany({
        where: {
          OR: [{ senderAccNo: Acc }, { receiverAccNo: Acc }],
        },
        include: {
          senderAccount: {
            include: {
              customer: true,
            },
          },
          receiverAccount: {
            include: {
              customer: true,
            },
          },
          loan: true,
        },
        orderBy: { timestamp: "desc" },
      });

      res.status(200).json(transactions);
    } catch (error) {
      console.error("Transaction error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// GET all transactions associated with any account owned by a customer
router.get(
  "/byCustomer/:customerId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { customerId } = req.params;
      if (!customerId) {
        res.status(400).json({ error: "Customer ID is required" });
        return;
      }

      // Query transactions where either the sender OR receiver account belongs to the customer
      const transactions = await prisma.transaction.findMany({
        where: {
          OR: [
            { senderAccount: { customerId: customerId } },
            { receiverAccount: { customerId: customerId } },
          ],
        },
        include: {
          senderAccount: {
            include: {
              customer: {
                select: { name: true, email: true, id: true }
              },
            },
          },
          receiverAccount: {
            include: {
              customer: {
                select: { name: true, email: true, id: true }
              },
            },
          },
          loan: true,
        },
        orderBy: { timestamp: "desc" },
      });

      res.status(200).json(transactions);
    } catch (error) {
      console.error("Transaction by customer error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// Zod schema for creating a transaction
const createTransactionSchema = z.object({
  senderAccNo: z.string().min(1, "Sender account number is required"),
  receiverAccNo: z.string().min(1, "Receiver account number is required"),
  amount: z.number().positive("Amount must be positive"),
  transactionType: z.enum([
    "PAYMENT",
    "TRANSFER",
    "PRO_LICENSE_FEE",
    "DEPOSIT",
    "WITHDRAWAL",
  ]),
  status: z.union([z.boolean(), z.enum(["SUCCESS", "FAILED", "PENDING"])]),
  category: z.string().min(1, "Category is required"),
  description: z.string().optional(),
});

// POST — create a new transaction (with atomic balance updates)
router.post(
  "/transactions",
  async (req: Request, res: Response): Promise<void> => {
    const parseResult = createTransactionSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ errors: parseResult.error.errors });
      return;
    }

    const {
      senderAccNo,
      receiverAccNo,
      amount,
      transactionType,
      status,
      category,
      description,
    } = parseResult.data;

    if (senderAccNo === receiverAccNo) {
      res.status(400).json({
        error: "Sender and Receiver Account Number cannot be the same",
      });
      return;
    }

    try {
      // Use a database transaction for atomicity
      const result = await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          // Verify sender account exists and has sufficient balance
          const sender = await tx.account.findUnique({
            where: { accNo: senderAccNo },
            include: { customer: true },
          });

          if (!sender) {
            throw new Error("Sender account not found");
          }

          if (transactionType === "TRANSFER" && sender.balance < amount) {
            throw new Error("Insufficient funds");
          }

          // Verify receiver account exists
          const receiver = await tx.account.findUnique({
            where: { accNo: receiverAccNo },
            include: { customer: true },
          });

          if (!receiver) {
            throw new Error("Receiver account not found");
          }

          const isCrossBank = sender.customer.tenantId !== receiver.customer.tenantId;

          // Create the transaction record
          const newTransaction = await tx.transaction.create({
            data: {
              senderAccNo,
              receiverAccNo,
              amount,
              transactionType,
              status: typeof status === "boolean" ? (status ? "SUCCESS" : "FAILED") : status,
              category: isCrossBank ? "CROSS_TRANSFER" : category,
              description: description ?? null,
              loanId: null,
            },
          });

          // Update balances if it's a transfer or payment
          if (transactionType === "TRANSFER" || transactionType === "PAYMENT") {
            await tx.account.update({
              where: { accNo: senderAccNo },
              data: { balance: { decrement: amount } },
            });

            await tx.account.update({
              where: { accNo: receiverAccNo },
              data: { balance: { increment: amount } },
            });
          }

          return newTransaction;
        }
      );

      // Fire an analytics event whose NAME reflects what actually happened.
      //
      // Previously this fired unconditionally -- "transfer_completed" or "payees" regardless
      // of `result.status` -- so a FAILED or PENDING transaction (both valid values of the
      // `status` field this same handler accepts and persists) would still emit a
      // success-shaped event. Neither literal was even taxonomy-valid for a success, verified
      // through the real chain (Node enforceTaxonomy -> ingest normalization ->
      // canonicalize_event_name):
      //   "transfer_completed" -> core.transfer_completed.action -- not referenced by any
      //     contract; a completed transfer read as zero, silently, on every KPI.
      //   "payees" -> payee.page.view -- a completed PAYMENT counted as a page view of the
      //     unrelated payees list page, polluting that counter with transaction completions.
      // Replaced with the taxonomy the LEGACY_MAP in eventTracker.ts already defines for
      // payments (transactions.pay_now.success/failed -> transaction.pay_now.success/failure)
      // and a matching pair added for transfers (transactions.transfer.success/failed ->
      // transaction.transfer.success/failure, verified clean, no existing collision).
      try {
        const senderInfo = await prisma.account.findUnique({
          where: { accNo: senderAccNo },
          include: { customer: true }
        });
        if (senderInfo) {
          const succeeded = result.status === "SUCCESS";
          const eventName = transactionType === "TRANSFER"
            ? (succeeded ? "transfer_completed" : "transfer_failed")
            : (succeeded ? "payment_completed" : "payment_failed");
          await trackEvent(
            eventName,
            senderInfo.customerId,
            senderInfo.customer.tenantId || "bank_a",
            {
              // `channel`: createTransactionSchema does not accept one in the request, but
              // the Prisma Transaction model defaults it to WEB (schema.prisma:72) and it IS
              // present on the created record -- read from `result.channel`, the actual
              // source value, rather than either fabricating one or omitting a real field.
              amount,
              category: result.category,
              transactionId: result.id,
              status: result.status,
              channel: result.channel,
              transactionType,
            }
          );
        }
      } catch (trackErr) {
        console.error("Failed to track transaction:", trackErr);
      }

      res.status(201).json(result);
    } catch (error) {
      console.error("Transaction error:", error);
      const message =
        error instanceof Error ? error.message : "Internal Server Error";

      if (
        message === "Sender account not found" ||
        message === "Receiver account not found"
      ) {
        res.status(404).json({ error: message });
      } else if (message === "Insufficient funds") {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: "Internal Server Error" });
      }
    }
  }
);

export default router;