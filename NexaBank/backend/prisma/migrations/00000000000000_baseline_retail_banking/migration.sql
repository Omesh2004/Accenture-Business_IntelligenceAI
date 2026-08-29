-- CreateEnum
CREATE TYPE "CustomerRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'SHOPPING', 'ENTERTAINMENT', 'HOUSING', 'FOOD', 'OTHERS');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('SAVINGS', 'CURRENT', 'LOAN', 'CREDIT_CARD', 'INVESTMENT');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PAYMENT', 'TRANSFER', 'PRO_LICENSE_FEE', 'DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "LoanType" AS ENUM ('HOME', 'AUTO', 'PERSONAL', 'STUDENT');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'KYC_PENDING', 'UNDER_REVIEW');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransactionChannel" AS ENUM ('WEB', 'MOBILE', 'ATM', 'POS');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('SUCCESS', 'FAILED', 'PENDING', 'REVERSED');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'CLOSED', 'DEFAULTED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DORMANT', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AgeBracket" AS ENUM ('UNDER_25', 'AGE_25_34', 'AGE_35_49', 'AGE_50_64', 'AGE_65_PLUS');

-- CreateEnum
CREATE TYPE "IncomeBracket" AS ENUM ('UNDER_30K', 'INC_30K_60K', 'INC_60K_100K', 'INC_100K_200K', 'INC_200K_PLUS');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('SALARIED', 'SELF_EMPLOYED', 'STUDENT', 'RETIRED', 'UNEMPLOYED');

-- CreateEnum
CREATE TYPE "RiskSegment" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CampaignChannel" AS ENUM ('EMAIL', 'SMS', 'APP_PUSH', 'BRANCH');

-- CreateEnum
CREATE TYPE "InteractionType" AS ENUM ('SENT', 'OPENED', 'CLICKED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "CardType" AS ENUM ('DEBIT', 'CREDIT', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "CardNetwork" AS ENUM ('VISA', 'MASTERCARD', 'AMEX', 'RUPAY');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('ACTIVE', 'LOCKED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SECURITY', 'TRANSACTION', 'MARKETING', 'SYSTEM');

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL DEFAULT 'INDIVIDUAL',
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "pan" TEXT NOT NULL,
    "settingConfig" JSONB NOT NULL,
    "address" JSONB NOT NULL,
    "role" "CustomerRole" NOT NULL DEFAULT 'USER',
    "tenantId" TEXT NOT NULL DEFAULT 'bank_a',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "kycCompletedAt" TIMESTAMP(3),
    "lastLogin" TIMESTAMP(3),
    "ageBracket" "AgeBracket",
    "incomeBracket" "IncomeBracket",
    "employmentStatus" "EmploymentStatus",
    "riskSegment" "RiskSegment",
    "lifetimeValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "branchCode" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ifscPrefix" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "accNo" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "ifsc" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL DEFAULT 'SAVINGS',
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedOn" TIMESTAMP(3) NOT NULL,
    "deletedOn" TIMESTAMP(3),
    "investment" JSONB[],
    "lifecycleStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "interestRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "branchCode" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("accNo")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" UUID NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "senderAccNo" TEXT NOT NULL,
    "receiverAccNo" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'SUCCESS',
    "category" TEXT NOT NULL,
    "channel" "TransactionChannel" NOT NULL DEFAULT 'WEB',
    "description" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loanId" UUID,
    "merchantCategoryCode" TEXT,
    "merchantName" TEXT,
    "referenceNumber" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" UUID NOT NULL,
    "loanType" "LoanType" NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL,
    "principalAmount" DOUBLE PRECISION NOT NULL,
    "interestAmount" DOUBLE PRECISION NOT NULL,
    "term" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedOn" TIMESTAMP(3) NOT NULL,
    "schedule" JSONB[],
    "dueAmount" DOUBLE PRECISION NOT NULL,
    "accNo" TEXT NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanApplication" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "loanType" "LoanType" NOT NULL,
    "principalAmount" DOUBLE PRECISION NOT NULL,
    "term" INTEGER NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "kycData" JSONB NOT NULL,
    "kycStep" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "reviewedBy" UUID,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payee" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payeeAccNo" TEXT NOT NULL,
    "payeeifsc" TEXT NOT NULL,
    "payeeCustomerId" UUID NOT NULL,
    "payerCustomerId" UUID NOT NULL,
    "payeeType" "CustomerType" NOT NULL DEFAULT 'INDIVIDUAL',
    "bankName" TEXT,
    "nickname" TEXT,

    CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "eventName" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" UUID,
    "metadata" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserLocation" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "country" TEXT,
    "city" TEXT,
    "ip" TEXT,
    "deviceType" TEXT,
    "userAgent" TEXT,
    "platform" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserLicense" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "featureId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureToggle" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "FeatureToggle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "managerName" TEXT NOT NULL,
    "staffingHeadcount" INTEGER NOT NULL DEFAULT 0,
    "openedOn" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'bank_a',
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "MacroEnvironment" (
    "id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "monthYear" TEXT NOT NULL,
    "competitorDepositRate" DOUBLE PRECISION NOT NULL,
    "centralBankBaseRate" DOUBLE PRECISION NOT NULL,
    "regionalUnemploymentRate" DOUBLE PRECISION NOT NULL,
    "recordedOn" TIMESTAMP(3) NOT NULL,
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MacroEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "CampaignChannel" NOT NULL,
    "targetSegment" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tenantId" TEXT NOT NULL DEFAULT 'bank_a',
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignInteraction" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "InteractionType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" UUID NOT NULL,
    "accNo" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "last4" TEXT NOT NULL,
    "cardType" "CardType" NOT NULL,
    "network" "CardNetwork" NOT NULL,
    "productName" TEXT NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "cardholderName" TEXT NOT NULL,
    "status" "CardStatus" NOT NULL DEFAULT 'ACTIVE',
    "creditLimit" DOUBLE PRECISION,
    "availableCredit" DOUBLE PRECISION,
    "issuedOn" TIMESTAMP(3) NOT NULL,
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_pan_key" ON "Customer"("pan");

-- CreateIndex
CREATE UNIQUE INDEX "Account_accNo_key" ON "Account"("accNo");

-- CreateIndex
CREATE UNIQUE INDEX "UserLicense_customerId_featureId_key" ON "UserLicense"("customerId", "featureId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureToggle_key_tenantId_key" ON "FeatureToggle"("key", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MacroEnvironment_region_monthYear_key" ON "MacroEnvironment"("region", "monthYear");

-- CreateIndex
CREATE INDEX "CampaignInteraction_campaignId_type_idx" ON "CampaignInteraction"("campaignId", "type");

-- CreateIndex
CREATE INDEX "Card_productName_idx" ON "Card"("productName");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_branchCode_fkey" FOREIGN KEY ("branchCode") REFERENCES "Branch"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_branchCode_fkey" FOREIGN KEY ("branchCode") REFERENCES "Branch"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_receiverAccNo_fkey" FOREIGN KEY ("receiverAccNo") REFERENCES "Account"("accNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_senderAccNo_fkey" FOREIGN KEY ("senderAccNo") REFERENCES "Account"("accNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_accNo_fkey" FOREIGN KEY ("accNo") REFERENCES "Account"("accNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payee" ADD CONSTRAINT "Payee_payeeAccNo_fkey" FOREIGN KEY ("payeeAccNo") REFERENCES "Account"("accNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payee" ADD CONSTRAINT "Payee_payeeCustomerId_fkey" FOREIGN KEY ("payeeCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payee" ADD CONSTRAINT "Payee_payerCustomerId_fkey" FOREIGN KEY ("payerCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocation" ADD CONSTRAINT "UserLocation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLicense" ADD CONSTRAINT "UserLicense_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureToggle" ADD CONSTRAINT "FeatureToggle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignInteraction" ADD CONSTRAINT "CampaignInteraction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignInteraction" ADD CONSTRAINT "CampaignInteraction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_accNo_fkey" FOREIGN KEY ("accNo") REFERENCES "Account"("accNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

