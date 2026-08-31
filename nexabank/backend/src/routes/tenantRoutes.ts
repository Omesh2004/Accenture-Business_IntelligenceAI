import express, { Request, Response } from "express";
import { prisma } from "../prisma";

const router = express.Router();

/**
 * GET /api/tenants/ifsc-list
 * Returns a list of available banks and their generated IFSC codes.
 */
router.get("/tenants/ifsc-list", async (_req: Request, res: Response): Promise<void> => {
  try {
    const tenants = await prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        ifscPrefix: true,
        branchCode: true,
      },
    });

    const ifscList = tenants.map((t: any) => ({
      bankName: t.name,
      ifsc: `${t.ifscPrefix}${t.branchCode}`,
      tenantId: t.id,
    }));

    res.status(200).json(ifscList);
  } catch (error) {
    console.error("Tenant fetch error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
