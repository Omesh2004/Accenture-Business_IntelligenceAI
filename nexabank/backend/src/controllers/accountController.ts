import { Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { z } from "zod";
import { validationResult } from "express-validator";
import { prisma } from "../prisma";
import { generateUniqueAccountNumber } from "../helper/account";

// Schema validation using Zod — matches Prisma AccountType enum
const AccountSchema = z.object({
  customerId: z.string().uuid("Invalid customer ID format"),
  ifsc: z.string().min(1, "IFSC code is required"),
  accountType: z.enum([
    "SAVINGS",
    "CURRENT",
    "LOAN",
    "CREDIT_CARD",
    "INVESTMENT",
  ]),
  balance: z
    .number()
    .min(0, "Balance must be a non-negative number")
    .default(0),
});

export const createAccount = async (
  req: Request,
  res: Response
): Promise<void> => {
  // Check express-validator validation results
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }

  // Parse and validate with Zod
  const parseResult = AccountSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ errors: parseResult.error.errors });
    return;
  }

  const { customerId, ifsc, accountType, balance } = parseResult.data;

  try {
    // Check if customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const accNo = await generateUniqueAccountNumber();

    const account = await prisma.account.create({
      data: {
        customerId,
        ifsc,
        accountType,
        balance,
        accNo,
      },
    });

    res.status(201).json(account);
  } catch (error) {
    console.error("Account creation error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const getAccountById = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { id } = req.params;

  try {
    const account = await prisma.account.findUnique({
      where: { accNo: id },
    });

    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    res.status(200).json(account);
  } catch (error) {
    console.error("Error fetching account:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const getAccountsByCustomerId = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { customerId } = req.params;

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const accounts = await prisma.account.findMany({
      where: {
        customerId,
        lifecycleStatus: "ACTIVE",
      },
    });

    res.status(200).json(accounts);
  } catch (error) {
    console.error("Error fetching customer accounts:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const transferBetweenOwnAccounts = async (
  req: Request,
  res: Response
): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }

  const TransferSchema = z.object({
    fromAccountNo: z.string().min(1, "Source account number is required"),
    toAccountNo: z.string().min(1, "Destination account number is required"),
    amount: z.number().positive("Transfer amount must be positive"),
    description: z.string().optional(),
  });

  const parseResult = TransferSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ errors: parseResult.error.errors });
    return;
  }

  const {
    fromAccountNo,
    toAccountNo,
    amount,
    description = "Self Transfer",
  } = parseResult.data;

  try {
    // Verify both accounts exist and are active
    const fromAccount = await prisma.account.findUnique({
      where: { accNo: fromAccountNo, lifecycleStatus: "ACTIVE" },
      include: { customer: true },
    });

    const toAccount = await prisma.account.findUnique({
      where: { accNo: toAccountNo, lifecycleStatus: "ACTIVE" },
      include: { customer: true },
    });

    if (!fromAccount) {
      res.status(404).json({ error: "Source account not found or inactive" });
      return;
    }

    if (!toAccount) {
      res.status(404).json({ error: "Destination account not found or inactive" });
      return;
    }

    if (fromAccount.customerId !== toAccount.customerId) {
      res.status(403).json({
        error: "Transfer only allowed between accounts owned by the same customer",
      });
      return;
    }

    if (fromAccount.balance < amount) {
      res.status(400).json({ error: "Insufficient funds" });
      return;
    }

    // Atomic transaction
    const transfer = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const updatedFromAccount = await tx.account.update({
          where: { accNo: fromAccountNo },
          data: { balance: { decrement: amount } },
        });

        const updatedToAccount = await tx.account.update({
          where: { accNo: toAccountNo },
          data: { balance: { increment: amount } },
        });

        const isCrossBank = fromAccount.customer.tenantId !== toAccount.customer.tenantId;
        const transaction = await tx.transaction.create({
          data: {
            transactionType: "TRANSFER",
            senderAccNo: fromAccountNo,
            receiverAccNo: toAccountNo,
            amount,
            status: "SUCCESS",
            category: isCrossBank ? "CROSS_TRANSFER" : "SELF_TRANSFER",
            description,
          },
        });

        return {
          transaction,
          fromAccount: updatedFromAccount,
          toAccount: updatedToAccount,
        };
      }
    );

    res.status(200).json({
      message: "Transfer successful",
      transactionId: transfer.transaction.id,
      fromAccount: {
        accountNumber: transfer.fromAccount.accNo,
        newBalance: transfer.fromAccount.balance,
      },
      toAccount: {
        accountNumber: transfer.toAccount.accNo,
        newBalance: transfer.toAccount.balance,
      },
    });
  } catch (error) {
    console.error("Transfer error:", error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ errors: error.errors });
      return;
    }
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const payToPayee = async (
  req: Request,
  res: Response
): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }

  const TransferSchema = z.object({
    fromAccountNo: z.string().min(1, "Source account number is required"),
    toAccountNo: z.string().min(1, "Destination account number is required"),
    amount: z.number().positive("Transfer amount must be positive"),
    description: z.string().optional(),
  });

  const parseResult = TransferSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ errors: parseResult.error.errors });
    return;
  }

  const {
    fromAccountNo,
    toAccountNo,
    amount,
    description = "Payment to Payee",
  } = parseResult.data;

  try {
    // Verify both accounts exist and are active
    const fromAccount = await prisma.account.findUnique({
      where: { accNo: fromAccountNo, lifecycleStatus: "ACTIVE" },
      include: { customer: true },
    });

    const toAccount = await prisma.account.findUnique({
      where: { accNo: toAccountNo, lifecycleStatus: "ACTIVE" },
    });

    if (!fromAccount) {
      res.status(404).json({ error: "Source account not found or inactive" });
      return;
    }

    if (!toAccount) {
      res.status(404).json({ error: "Destination account not found or inactive" });
      return;
    }

    if (fromAccount.balance < amount) {
      res.status(400).json({ error: "Insufficient funds" });
      return;
    }

    // Atomic transaction
    const transfer = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const updatedFromAccount = await tx.account.update({
          where: { accNo: fromAccountNo },
          data: { balance: { decrement: amount } },
        });

        const updatedToAccount = await tx.account.update({
          where: { accNo: toAccountNo },
          data: { balance: { increment: amount } },
        });

        const fromTenant = fromAccount.customer.tenantId;
        // Fetch receiver's tenantId since it wasn't included in the initial findUnique
        const receiverCustomer = await tx.customer.findUnique({
          where: { id: toAccount.customerId },
          select: { tenantId: true }
        });
        
        const isCrossBank = fromTenant !== receiverCustomer?.tenantId;

        const transaction = await tx.transaction.create({
          data: {
            transactionType: "PAYMENT",
            senderAccNo: fromAccountNo,
            receiverAccNo: toAccountNo,
            amount,
            status: "SUCCESS",
            category: isCrossBank ? "CROSS_TRANSFER" : "PAYEE_TRANSFER",
            description,
          },
        });

        return {
          transaction,
          fromAccount: updatedFromAccount,
          toAccount: updatedToAccount,
        };
      }
    );

    res.status(200).json({
      message: "Payment successful",
      transactionId: transfer.transaction.id,
      fromAccount: {
        accountNumber: transfer.fromAccount.accNo,
        newBalance: transfer.fromAccount.balance,
      },
    });
  } catch (error) {
    console.error("Payment error:", error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ errors: error.errors });
      return;
    }
    res.status(500).json({ error: "Internal Server Error" });
  }
};
