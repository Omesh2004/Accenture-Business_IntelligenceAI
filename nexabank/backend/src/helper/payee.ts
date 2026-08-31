import { Request, Response } from "express";
import { prisma } from "../prisma";
import { CustomerType } from "@prisma/client";

interface AuthenticatedRequest extends Request {
  user?: { id: string };
  body: {
    name: string;
    payeeifsc: string;
    payeeAccNo: string;
    payeeType: CustomerType;
  };
}

interface CheckPayeeRequest extends Request {
  body: {
    data: {
      payeeifsc: string;
      payeeAccNo: string;
    };
  };
}

export const AddPayee = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { name, payeeifsc, payeeAccNo, payeeType } = req.body;
    const { payerCustomerId } = req.params;

    if (req.user?.id !== payerCustomerId) {
      res.status(403).json({ error: "Unauthorized access to this payer" });
      return;
    }

    const accountExists = await prisma.account.findUnique({
      where: { accNo: payeeAccNo },
    });

    if (!accountExists) {
      res.status(404).json({ error: "Account does not exist" });
      return;
    }

    const payeeCustomerId = accountExists.customerId;
    const ifsc = accountExists.ifsc;

    const AlreadyPayeeExists = await prisma.payee.findFirst({
      where: {
        payeeCustomerId,
        payerCustomerId,
      },
    });

    if (AlreadyPayeeExists) {
      res.status(409).json({ error: "Payee already exists for this payer" });
      return;
    }

    if (payeeifsc !== ifsc) {
      res
        .status(400)
        .json({ error: "Provided IFSC does not match the account's IFSC" });
      return;
    }

    const payee = await prisma.payee.create({
      data: {
        name,
        payeeAccNo,
        payeeType,
        payeeifsc,
        payeeCustomerId,
        payerCustomerId,
      },
    });

    res.status(201).json(payee);
  } catch (error) {
    console.error("Error creating payee:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to create payee",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
};

export const fetchPayee = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { payerCustomerId } = req.params;
    if (req.user?.id !== payerCustomerId) {
      res.status(403).json({ error: "Unauthorized access to this payer" });
      return;
    }
    const payees = await prisma.payee.findMany({
      where: { payerCustomerId },
    });

    res.status(200).json(payees);
  } catch (error) {
    console.error("Error fetch payee:", error);
    res.status(500).json({
      error: "Failed to fetch payee",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const EditPayee = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { name, payeeifsc, payeeAccNo, payeeType } = req.body;
    const { payerCustomerId } = req.params;

    if (req.user?.id !== payerCustomerId) {
      res.status(403).json({ error: "Unauthorized access to this payer" });
      return;
    }

    const accountExists = await prisma.account.findUnique({
      where: { accNo: payeeAccNo },
    });

    if (!accountExists) {
      res.status(404).json({ error: "Account does not exist" });
      return;
    }

    const payeeCustomerId = accountExists.customerId;
    const ifsc = accountExists.ifsc;

    if (payeeifsc !== ifsc) {
      res
        .status(400)
        .json({ error: "Provided IFSC does not match the account's IFSC" });
      return;
    }

    const existingPayee = await prisma.payee.findFirst({
      where: {
        payerCustomerId,
        payeeCustomerId,
      },
    });

    if (!existingPayee) {
      res.status(404).json({ error: "Payee not found for this payer" });
      return;
    }

    const updatedPayee = await prisma.payee.update({
      where: { id: existingPayee.id },
      data: { name, payeeType },
    });

    res.status(200).json(updatedPayee);
  } catch (error) {
    console.error("Error Editing Payee:", error);
    res.status(500).json({
      error: "Failed to edit payee",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deletePayee = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { payeeAccNo } = req.body;
    const { payerCustomerId } = req.params;

    if (req.user?.id !== payerCustomerId) {
      res.status(403).json({ error: "Unauthorized access to this payer" });
      return;
    }

    const accountExists = await prisma.account.findUnique({
      where: { accNo: payeeAccNo },
    });

    if (!accountExists) {
      res.status(404).json({ error: "Account does not exist" });
      return;
    }

    const payeeCustomerId = accountExists.customerId;

    const existingPayee = await prisma.payee.findFirst({
      where: {
        payerCustomerId,
        payeeCustomerId,
      },
    });

    if (!existingPayee) {
      res.status(404).json({ error: "Payee not found for this payer" });
      return;
    }

    const deletedPayee = await prisma.payee.delete({
      where: {
        id: existingPayee.id,
        payerCustomerId,
        payeeCustomerId,
      },
    });

    res.status(200).json({
      deletedPayee,
      message: "Payee deleted successfully",
    });
  } catch (error) {
    console.error("Error Deleting Payee:", error);
    res.status(500).json({
      error: "Failed to Delete payee",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const CheckPayeeName = async (
  req: CheckPayeeRequest,
  res: Response
): Promise<void> => {
  try {
    const { payeeifsc, payeeAccNo } = req.body.data;

    if (!payeeifsc || !payeeAccNo) {
      res.status(400).json({
        error: "Missing required fields: payeeifsc, payeeAccNo",
        details: {
          requiredFields: ["payeeifsc", "payeeAccNo"],
          providedFields: Object.keys(req.body),
        },
      });
      return;
    }

    const account = await prisma.account.findUnique({
      where: {
        accNo: payeeAccNo,
      },
      include: {
        customer: true,
      },
    });

    if (!account) {
      res.status(404).json({ error: "Account does not exist" });
      return;
    }

    if (account.ifsc !== payeeifsc) {
      res.status(400).json({ error: "IFSC does not match account" });
      return;
    }

    if (!account.customer || !account.customer.name) {
      res.status(400).json({
        error: "Invalid account data",
        details: {
          message: "Customer information is missing or incomplete",
        },
      });
      return;
    }

    res.status(200).json({
      customerName: account.customer.name,
    });
  } catch (error) {
    console.error("Error checking payee name:", error);
    res.status(500).json({
      error: "Failed to Find Name of payee",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const SearchPayees = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const query = req.query.q as string;

    if (!query || query.trim() === "") {
      res.status(400).json({ error: "Missing or invalid query parameter" });
      return;
    }

    const matchingCustomers = await prisma.customer.findMany({
      where: { name: { contains: query, mode: "insensitive" } },
      select: { id: true }
    });
    const customerIds = matchingCustomers.map((c: any) => c.id);

    const accounts = await prisma.account.findMany({
      where: {
        OR: [
          { accNo: { contains: query, mode: "insensitive" } },
          { customerId: { in: customerIds } }
        ],
      },
      include: {
        customer: {
          include: {
            tenant: true
          }
        },
      },
      take: 10,
    });

    const results = accounts.map((acc: any) => ({
      name: acc.customer?.name || "Unknown",
      accNo: acc.accNo,
      ifsc: acc.ifsc,
      bankName: acc.customer?.tenant?.name || "NexaBank"
    }));

    res.status(200).json(results);
  } catch (error) {
    console.error("Error searching payees:", error);
    res.status(500).json({
      error: "Failed to search payees",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
