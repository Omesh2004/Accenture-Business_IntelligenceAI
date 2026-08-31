import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ─── Configuration from Environment ─────────────────────────────
const TENANTS = [
  {
    id: process.env.TENANT_A_ID || "bank_a",
    name: process.env.TENANT_A_NAME || "NexaBank",
    ifscPrefix: process.env.TENANT_A_IFSC || "NEXA",
    branchCode: process.env.TENANT_A_BRANCH || "0001"
  },
  {
    id: process.env.TENANT_B_ID || "bank_b",
    name: process.env.TENANT_B_NAME || "SafeX Bank",
    ifscPrefix: process.env.TENANT_B_IFSC || "SAFX",
    branchCode: process.env.TENANT_B_BRANCH || "0001"
  }
];

const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "system@nexabank.internal";
const SYSTEM_PASSWORD = process.env.SYSTEM_PASSWORD || generateSecurePassword();
const SYSTEM_NAME = process.env.SYSTEM_NAME || "NexaBank System";
const SYSTEM_TENANT = process.env.SYSTEM_TENANT || "bank_a";

// ─── System accounts configuration ──────────────────────────────
const SYSTEM_ACCOUNTS = [
  { accNo: process.env.ACC_PRO_LICENSE || "NEXABANK-SYSTEM", label: "Pro License Revenue" },
  { accNo: process.env.ACC_REVENUE || "NEXABANK-SYSTEM-REVENUE", label: "System Revenue" },
  { accNo: process.env.ACC_EXTERNAL || "EXTERNAL-BANK", label: "External Bank Inflows" },
  { accNo: process.env.ACC_MERCHANT || "MERCHANT-ID", label: "Merchant Payments" },
  { accNo: process.env.ACC_CRYPTO || "CRYPTO-EXCHANGE", label: "Crypto Exchange" },
  { accNo: process.env.ACC_WEALTH || "WEALTH-REBALANCE-SYS", label: "Wealth Rebalance System" },
];

const FEATURE_TOGGLES = [
  { key: "emi_calculator", tenantId: TENANTS[0].id },
  { key: "kyc", tenantId: TENANTS[0].id },
  { key: "loan_module", tenantId: TENANTS[0].id },
  { key: "pro_features", tenantId: TENANTS[0].id },
  { key: "emi_calculator", tenantId: TENANTS[1].id },
  { key: "kyc", tenantId: TENANTS[1].id },
  { key: "loan_module", tenantId: TENANTS[1].id },
  { key: "pro_features", tenantId: TENANTS[1].id },
];

// ─── Helper: Generate secure random password ────────────────────
function generateSecurePassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
  let pwd = "";
  for (let i = 0; i < 16; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

async function main() {
  // ─── 1. Seed Tenants ─────────────────────────────────────────
  for (const tenant of TENANTS) {
    await prisma.tenant.upsert({
      where: { id: tenant.id },
      update: {},
      create: tenant
    });
  }
  console.log(`✅ ${TENANTS.length} Tenants seeded.`);

  // ─── 2. Seed System Customer + System Accounts ───────────────
  // These accounts are needed as FK references for simulation,
  // pro unlock, crypto trades, and external bank transactions.
  const hashedPw = await bcrypt.hash(SYSTEM_PASSWORD, 10);

  let systemCustomer = await prisma.customer.findUnique({
    where: { email: SYSTEM_EMAIL },
  });

  if (!systemCustomer) {
    systemCustomer = await prisma.customer.create({
      data: {
        name: SYSTEM_NAME,
        email: SYSTEM_EMAIL,
        phone: "0000000000",
        password: hashedPw,
        dateOfBirth: new Date("2000-01-01"),
        pan: "SYSXX0000S",
        tenantId: SYSTEM_TENANT,
        settingConfig: {},
        address: { city: "System", state: "Internal" },
        role: "ADMIN",
        kycStatus: "VERIFIED",
      },
    });
    console.log("✅ System customer created.");
  }

  // System accounts used across the app
  for (const sa of SYSTEM_ACCOUNTS) {
    const exists = await prisma.account.findUnique({
      where: { accNo: sa.accNo },
    });
    if (!exists) {
      await prisma.account.create({
        data: {
          accNo: sa.accNo,
          customerId: systemCustomer.id,
          ifsc: `${TENANTS[0].ifscPrefix}0001`,
          accountType: "CURRENT",
          balance: 0,
        },
      });
      console.log(`  ✅ System account "${sa.accNo}" created (${sa.label}).`);
    }
  }

  // ─── 3. Seed Feature Toggles ─────────────────────────────────
  for (const toggle of FEATURE_TOGGLES) {
    await prisma.featureToggle.upsert({
      where: { key_tenantId: { key: toggle.key, tenantId: toggle.tenantId } },
      update: {},
      create: { key: toggle.key, enabled: true, tenantId: toggle.tenantId },
    });
  }

  console.log(`✅ ${FEATURE_TOGGLES.length} Feature toggles seeded.`);
  console.log("\n🎉 Seeding complete!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
