import { Request, Response } from "express";
import { prisma } from "../prisma";
import { trackEvent } from "../middleware/eventTracker";
import axios from "axios";

/** Typed request with authenticated user */
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    tenantId?: string;
  };
}

/** Typed investment entry stored in account.investment JSON */
interface Investment {
  type: string;
  asset: string;
  amount: number;
  avgPrice: number;
}

// ═══════════════════════════════════════════════════════════════
// ─── POST /pro/unlock ──────────────────────────────────────────
// Deducts ₹2,000 and issues a 1-month license
// ═══════════════════════════════════════════════════════════════
export const unlockFeature = async (req: Request, res: Response): Promise<void> => {
  const { featureId } = req.body;
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!featureId || !customerId) {
    res.status(400).json({ error: "Missing featureId or customerId" });
    return;
  }

  try {
    const accounts = await prisma.account.findMany({
      where: { customerId, accountType: { in: ["SAVINGS", "CURRENT", "INVESTMENT"] } },
      orderBy: { balance: "desc" },
    });

    if (accounts.length === 0 || accounts[0].balance < 2000) {
      res.status(400).json({ error: "Insufficient funds. ₹2,000 required." });
      return;
    }

    const primaryAccount = accounts[0];

    const result = await prisma.$transaction(async (tx: any) => {
      await tx.account.update({
        where: { accNo: primaryAccount.accNo },
        data: { balance: { decrement: 2000 } },
      });

      await tx.transaction.create({
        data: {
          transactionType: "PRO_LICENSE_FEE",
          senderAccNo: primaryAccount.accNo,
          receiverAccNo: "NEXABANK-SYSTEM",
          amount: 2000,
          status: "SUCCESS",
          category: "Service Fee",
          description: `Unlock ${featureId} license`,
          channel: "WEB"
        },
      });

      const expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + 1);

      const license = await tx.userLicense.upsert({
        where: { customerId_featureId: { customerId, featureId } },
        update: { expiryDate, active: true, amount: 2000 },
        create: { customerId, featureId, amount: 2000, expiryDate },
      });

      return license;
    });

    await trackEvent("pro.features.unlock_success", customerId, tenantId, { featureId, amount: 2000 }, undefined, 'enterprise');

    res.status(200).json({
      message: "Feature unlocked successfully for 1 month",
      license: result,
    });
  } catch (err) {
    console.error("Unlock error:", err);
    res.status(500).json({ error: "Failed to unlock feature" });
  }
};

// ═══════════════════════════════════════════════════════════════
// ─── GET /pro/status ───────────────────────────────────────────
// Returns unlocked features for the user
// ═══════════════════════════════════════════════════════════════
export const getProStatus = async (req: Request, res: Response): Promise<void> => {
  const customerId = (req as AuthenticatedRequest).user?.id;
  if (!customerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const licenses = await prisma.userLicense.findMany({
      where: { customerId, active: true, expiryDate: { gt: new Date() } },
    });
    res.status(200).json(licenses);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch licenses" });
  }
};

// ═══════════════════════════════════════════════════════════════
// ─── FINANCE LIBRARY ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// POST /pro/access_book — Track book access (replaces download_book)
export const accessBook = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const { title, url } = req.body;
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!title || !customerId) {
    const responseTime = Date.now() - startTime;
    await trackEvent("ai_insights.book.failure", customerId || "unknown", tenantId, {
      feature: "ai-insights", title, status: "error", error: "missing_params", response_time_ms: responseTime
    }, undefined, 'enterprise').catch(() => { });
    res.status(400).json({ error: "Missing title" });
    return;
  }

  try {
    // Track the book access event with per-user granularity
    await trackEvent("ai_insights.book.success", customerId, tenantId, {
      feature: "ai-insights",
      title,
      url: url || "",
      status: "success",
      response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise');

    res.status(200).json({ success: true, message: `Accessing ${title}...` });
  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error("Book access error:", err);
    await trackEvent("ai_insights.book.failure", customerId, tenantId, {
      feature: "ai-insights", title, status: "error", error: String(err), response_time_ms: responseTime
    }, undefined, 'enterprise').catch(() => { });
    res.status(500).json({ error: "Failed to track book access" });
  }
};

// GET /pro/book_stats — Get per-user read counts for all books
export const getBookStats = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!customerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // Query all book access events for this user
    const events = await prisma.event.findMany({
      where: {
        customerId,
        eventName: "pro.finance-library.book_access",
      },
      select: { metadata: true },
    });

    // Count accesses per book title
    const bookCounts: Record<string, number> = {};
    for (const event of events) {
      const meta = event.metadata as any;
      if (meta?.title && meta?.status === "success") {
        bookCounts[meta.title] = (bookCounts[meta.title] || 0) + 1;
      }
    }

    await trackEvent("ai_insights.stats.view", customerId, tenantId, {
      feature: "ai-insights",
      books_tracked: Object.keys(bookCounts).length,
      status: "success",
      response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise');

    res.status(200).json({ counts: bookCounts });
  } catch (err) {
    console.error("Book stats error:", err);
    res.status(500).json({ error: "Failed to fetch book stats" });
  }
};

// ═══════════════════════════════════════════════════════════════
// ─── CRYPTO TRADING ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// In-memory price cache (30s TTL)
let cryptoPriceCache: { data: any; timestamp: number } | null = null;
const CRYPTO_CACHE_TTL = 30000; // 30 seconds

// GET /pro/crypto_prices — Real-time prices from CoinGecko
export const getCryptoPrices = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  try {
    // Check cache
    if (cryptoPriceCache && (Date.now() - cryptoPriceCache.timestamp) < CRYPTO_CACHE_TTL) {
      await trackEvent("crypto_trading.price_feeds.view", customerId || null, tenantId, {
        feature: "crypto-trading", source: "cache", status: "success",
        response_time_ms: Date.now() - startTime,
      }, undefined, 'enterprise').catch(() => { });
      res.status(200).json(cryptoPriceCache.data);
      return;
    }

    // Fetch from CoinGecko
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price", {
      params: {
        ids: "bitcoin,ethereum,solana,ripple,cardano",
        vs_currencies: "inr",
        include_24hr_change: true,
        include_24hr_vol: true,
        include_market_cap: true,
      },
      timeout: 5000,
    }
    );

    const raw = response.data;
    const formatted = {
      assets: [
        { id: "BTC", name: "Bitcoin", price: raw.bitcoin.inr, change24h: raw.bitcoin.inr_24h_change, volume: raw.bitcoin.inr_24h_vol, marketCap: raw.bitcoin.inr_market_cap },
        { id: "ETH", name: "Ethereum", price: raw.ethereum.inr, change24h: raw.ethereum.inr_24h_change, volume: raw.ethereum.inr_24h_vol, marketCap: raw.ethereum.inr_market_cap },
        { id: "SOL", name: "Solana", price: raw.solana.inr, change24h: raw.solana.inr_24h_change, volume: raw.solana.inr_24h_vol, marketCap: raw.solana.inr_market_cap },
        { id: "XRP", name: "Ripple", price: raw.ripple.inr, change24h: raw.ripple.inr_24h_change, volume: raw.ripple.inr_24h_vol, marketCap: raw.ripple.inr_market_cap },
        { id: "ADA", name: "Cardano", price: raw.cardano.inr, change24h: raw.cardano.inr_24h_change, volume: raw.cardano.inr_24h_vol, marketCap: raw.cardano.inr_market_cap },
      ],
      lastUpdated: new Date().toISOString(),
    };

    // Cache the result
    cryptoPriceCache = { data: formatted, timestamp: Date.now() };

    const responseTime = Date.now() - startTime;
    await trackEvent("crypto_trading.price_feeds.view", customerId || null, tenantId, {
      feature: "crypto-trading", source: "live", status: "success",
      response_time_ms: responseTime,
      assets_count: 5,
    }, undefined, 'enterprise').catch(() => { });

    res.status(200).json(formatted);
  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error("CoinGecko fetch error:", err);

    await trackEvent("crypto_trading.price_feeds.failure", customerId || null, tenantId, {
      feature: "crypto-trading", source: "live", status: "error",
      error: String(err), response_time_ms: responseTime,
    }, undefined, 'enterprise').catch(() => { });

    // Fallback static prices if API fails
    res.status(200).json({
      assets: [
        { id: "BTC", name: "Bitcoin", price: 5412042, change24h: 2.4, volume: 0, marketCap: 0 },
        { id: "ETH", name: "Ethereum", price: 155320, change24h: 1.8, volume: 0, marketCap: 0 },
        { id: "SOL", name: "Solana", price: 12450, change24h: -0.5, volume: 0, marketCap: 0 },
        { id: "XRP", name: "Ripple", price: 44.5, change24h: 3.2, volume: 0, marketCap: 0 },
        { id: "ADA", name: "Cardano", price: 31.2, change24h: -1.1, volume: 0, marketCap: 0 },
      ],
      lastUpdated: new Date().toISOString(),
      fallback: true,
    });
  }
};

// POST /pro/trade — Executes a crypto trade (BTC, ETH, SOL, XRP, ADA)
export const executeTrade = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const { asset, amount, price, type } = req.body; // type: 'BUY' | 'SELL'
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!asset || !amount || !price || !customerId) {
    const responseTime = Date.now() - startTime;
    await trackEvent("crypto_trading.trade_execution.failure", customerId || "unknown", tenantId, {
      feature: "crypto-trading", status: "error", error: "missing_params",
      response_time_ms: responseTime, asset, type
    }, undefined, 'enterprise').catch(() => { });
    res.status(400).json({ error: "Missing trade details" });
    return;
  }

  try {
    const account = await prisma.account.findFirst({
      where: { customerId, accountType: { in: ["SAVINGS", "CURRENT", "INVESTMENT"] } },
      orderBy: { balance: "desc" }
    });

    if (!account) {
      await trackEvent("crypto_trading.trade_execution.failure", customerId, tenantId, {
        feature: "crypto-trading", status: "error", error: "account_not_found",
        response_time_ms: Date.now() - startTime, asset, type
      }, undefined, 'enterprise').catch(() => { });
      res.status(404).json({ error: "Account not found" });
      return;
    }

    const totalCost = amount * price;
    if (type === "BUY" && account.balance < totalCost) {
      await trackEvent("crypto_trading.trade_execution.failure", customerId, tenantId, {
        feature: "crypto-trading", status: "error", error: "insufficient_funds",
        response_time_ms: Date.now() - startTime, asset, type, amount, totalCost
      }, undefined, 'enterprise').catch(() => { });
      res.status(400).json({ error: "Insufficient funds for trade" });
      return;
    }

    // Update investment JSON and balance
    const currentInvestments = (account.investment as unknown as Investment[]) || [];
    let updatedInvestments: Investment[] = [...currentInvestments];

    const assetIndex = updatedInvestments.findIndex((i: Investment) => i.asset === asset);

    if (type === "BUY") {
      if (assetIndex > -1) {
        updatedInvestments[assetIndex].amount += amount;
        updatedInvestments[assetIndex].avgPrice =
          (updatedInvestments[assetIndex].avgPrice + price) / 2;
      } else {
        updatedInvestments.push({ type: "CRYPTO", asset, amount, avgPrice: price });
      }
    } else {
      if (assetIndex === -1 || updatedInvestments[assetIndex].amount < amount) {
        await trackEvent("crypto_trading.trade_execution.failure", customerId, tenantId, {
          feature: "crypto-trading", status: "error", error: "insufficient_holdings",
          response_time_ms: Date.now() - startTime, asset, type, amount
        }, undefined, 'enterprise').catch(() => { });
        res.status(400).json({ error: "Insufficient asset holdings" });
        return;
      }
      updatedInvestments[assetIndex].amount -= amount;
      if (updatedInvestments[assetIndex].amount === 0) {
        updatedInvestments.splice(assetIndex, 1);
      }
    }

    await prisma.$transaction([
      prisma.account.update({
        where: { accNo: account.accNo },
        data: {
          balance: type === "BUY" ? { decrement: totalCost } : { increment: totalCost },
          investment: updatedInvestments as any
        },
      }),
      prisma.transaction.create({
        data: {
          transactionType: "PAYMENT",
          senderAccNo: type === "BUY" ? account.accNo : "CRYPTO-EXCHANGE",
          receiverAccNo: type === "BUY" ? "CRYPTO-EXCHANGE" : account.accNo,
          amount: totalCost,
          status: "SUCCESS",
          category: "Crypto Trade",
          description: `${type} ${amount} ${asset} @ ₹${price.toLocaleString("en-IN")}`,
          channel: "WEB"
        },
      }),
    ]);

    const responseTime = Date.now() - startTime;
    await trackEvent("crypto_trading.trade_execution.success", customerId, tenantId, {
      feature: "crypto-trading", asset, amount, type, totalCost,
      status: "success", response_time_ms: responseTime,
    }, undefined, 'enterprise');


    res.status(200).json({ success: true, investments: updatedInvestments });
  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error("Trade error:", err);
    await trackEvent("crypto_trading.trade_execution.failure", customerId || "unknown", tenantId, {
      feature: "crypto-trading", status: "error", error: String(err),
      response_time_ms: responseTime, asset, type
    }, undefined, 'enterprise').catch(() => { });
    res.status(500).json({ error: "Trade failed" });
  }
};

// GET /pro/portfolio — Get user's crypto holdings
export const getPortfolio = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!customerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const account = await prisma.account.findFirst({
      where: { customerId, accountType: { in: ["SAVINGS", "CURRENT", "INVESTMENT"] } },
      orderBy: { balance: "desc" },
    });

    const investments = account ? (account.investment as unknown as Investment[]) || [] : [];

    await trackEvent("crypto_trading.portfolio.view", customerId, tenantId, {
      feature: "crypto-trading", holdings_count: investments.length,
      status: "success", response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise').catch(() => { });

    res.status(200).json({
      holdings: investments.filter(i => i.type === "CRYPTO"),
      balance: account?.balance || 0,
    });
  } catch (err) {
    console.error("Portfolio error:", err);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
};

// ═══════════════════════════════════════════════════════════════
// ─── WEALTH MANAGEMENT ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// GET /pro/wealth_insights — Real DB-based wealth insights
export const getWealthInsights = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!customerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // 1. Get all accounts
    const accounts = await prisma.account.findMany({
      where: { customerId },
    });

    // 2. Get all transactions (last 90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const userAccNos = accounts.map(a => a.accNo);
    const transactions = await prisma.transaction.findMany({
      where: {
        timestamp: { gte: ninetyDaysAgo },
        OR: [
          { senderAccNo: { in: userAccNos } },
          { receiverAccNo: { in: userAccNos } },
        ],
      },
      orderBy: { timestamp: "desc" },
    });

    // 3. Compute category-wise spending
    const categorySpending: Record<string, number> = {};
    const monthlyFlow: Record<string, { income: number; expenses: number }> = {};
    let totalIncome = 0;
    let totalExpenses = 0;

    for (const tx of transactions) {
      const isSender = userAccNos.includes(tx.senderAccNo);
      const isReceiver = userAccNos.includes(tx.receiverAccNo);
      const monthKey = new Date(tx.timestamp).toISOString().slice(0, 7); // YYYY-MM

      if (!monthlyFlow[monthKey]) monthlyFlow[monthKey] = { income: 0, expenses: 0 };

      if (isSender && !isReceiver) {
        // Outgoing
        totalExpenses += tx.amount;
        monthlyFlow[monthKey].expenses += tx.amount;
        const cat = tx.category || "Others";
        categorySpending[cat] = (categorySpending[cat] || 0) + tx.amount;
      } else if (isReceiver && !isSender) {
        // Incoming
        totalIncome += tx.amount;
        monthlyFlow[monthKey].income += tx.amount;
      }
    }

    // 4. Investment portfolio breakdown
    const allInvestments: Investment[] = [];
    for (const acc of accounts) {
      const inv = (acc.investment as unknown as Investment[]) || [];
      allInvestments.push(...inv);
    }

    const investmentByType: Record<string, number> = {};
    for (const inv of allInvestments) {
      const value = inv.amount * inv.avgPrice;
      investmentByType[inv.type || "Other"] = (investmentByType[inv.type || "Other"] || 0) + value;
    }

    // 5. Compute totals
    const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);
    const investmentValue = allInvestments.reduce((s, i) => s + i.amount * i.avgPrice, 0);
    const netWorth = totalBalance + investmentValue;

    // 6. Top spending categories
    const topCategories = Object.entries(categorySpending)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, amount]) => ({ name, amount, percentage: totalExpenses > 0 ? (amount / totalExpenses * 100) : 0 }));

    // 7. Monthly flow data
    const monthlyFlowArray = Object.entries(monthlyFlow)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, data]) => ({ month, ...data }));

    const responseTime = Date.now() - startTime;
    await trackEvent("wealth_management_pro.insights.view", customerId, tenantId, {
      feature: "wealth-management-pro",
      transactions_analyzed: transactions.length,
      net_worth: netWorth,
    }, undefined, 'enterprise');

    res.status(200).json({
      netWorth,
      totalBalance,
      investmentValue,
      totalIncome,
      totalExpenses,
      savingsRate: totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome * 100) : 0,
      topCategories,
      monthlyFlow: monthlyFlowArray,
      investmentBreakdown: Object.entries(investmentByType).map(([type, value]) => ({ type, value })),
      accounts: accounts.map(a => ({
        accNo: a.accNo,
        type: a.accountType,
        balance: a.balance,
      })),
      transactionCount: transactions.length,
    });
  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error("Wealth insights error:", err);
    await trackEvent("wealth_management_pro.insights.failure", customerId || "unknown", tenantId, {
      feature: "wealth-management-pro", status: "error",
      error_msg: String(err), response_time_ms: responseTime,
    }, undefined, 'enterprise').catch(() => { });
    res.status(500).json({ error: "Failed to fetch wealth insights" });
  }
};

// POST /pro/rebalance_wealth — Rebalance portfolio
export const rebalanceWealth = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!customerId) {
    res.status(400).json({ error: "Missing customerId" });
    return;
  }

  try {
    // 1. Verify license
    const license = await prisma.userLicense.findFirst({
      where: { customerId, featureId: "wealth-management-pro", active: true, expiryDate: { gt: new Date() } }
    });
    if (!license) {
      await trackEvent("wealth_management_pro.rebalance.failure", customerId, tenantId, {
        feature: "wealth-management-pro", status: "error", error: "no_license",
        response_time_ms: Date.now() - startTime,
      }, undefined, 'enterprise').catch(() => { });
      res.status(403).json({ error: "Active wealth-management-pro license required." });
      return;
    }

    // 2. Get accounts and compute total portfolio value
    const accounts = await prisma.account.findMany({
      where: { customerId, accountType: { in: ["SAVINGS", "CURRENT", "INVESTMENT"] } },
    });

    if (accounts.length === 0) {
      res.status(404).json({ error: "No accounts found" });
      return;
    }

    const primaryAccount = accounts[0];
    const currentInvestments = (primaryAccount.investment as unknown as Investment[]) || [];
    const cashBalance = primaryAccount.balance;

    const investmentValue = currentInvestments.reduce((sum: number, inv: Investment) => {
      return sum + (inv.amount * inv.avgPrice);
    }, 0);

    const totalPortfolioValue = cashBalance + investmentValue;

    // 3. Target allocation weights
    const TARGET_WEIGHTS = {
      STOCKS: 0.40,
      BONDS: 0.25,
      CRYPTO: 0.20,
      CASH_RESERVE: 0.15,
    };

    // 4. Compute rebalanced portfolio
    const rebalancedInvestments = [
      { type: "STOCKS", asset: "INDEX_FUND", amount: 1, avgPrice: Math.round(totalPortfolioValue * TARGET_WEIGHTS.STOCKS) },
      { type: "BONDS", asset: "GOVT_BONDS", amount: 1, avgPrice: Math.round(totalPortfolioValue * TARGET_WEIGHTS.BONDS) },
      { type: "CRYPTO", asset: "BTC", amount: parseFloat(((totalPortfolioValue * TARGET_WEIGHTS.CRYPTO) / 5412042.45).toFixed(4)), avgPrice: 5412042.45 },
    ];

    const newCashBalance = Math.round(totalPortfolioValue * TARGET_WEIGHTS.CASH_RESERVE);

    // 5. Update database
    await prisma.$transaction([
      prisma.account.update({
        where: { accNo: primaryAccount.accNo },
        data: {
          balance: newCashBalance,
          investment: rebalancedInvestments as any,
        },
      }),
      prisma.transaction.create({
        data: {
          transactionType: "PAYMENT",
          senderAccNo: primaryAccount.accNo,
          receiverAccNo: "WEALTH-REBALANCE-SYS",
          amount: Math.abs(cashBalance - newCashBalance),
          status: "SUCCESS",
          category: "Portfolio Rebalance",
          description: `Rebalanced ₹${totalPortfolioValue.toLocaleString("en-IN")} across 4 asset classes`,
          channel: "WEB",
        },
      }),
    ]);

    const responseTime = Date.now() - startTime;
    await trackEvent("wealth_management_pro.rebalance.success", customerId, tenantId, {
      feature: "wealth-management-pro",
      totalValue: totalPortfolioValue,
      allocations: TARGET_WEIGHTS,
      status: "success",
      response_time_ms: responseTime,
    }, undefined, 'enterprise');


    res.status(200).json({
      success: true,
      message: "Portfolio rebalanced successfully",
      portfolio: {
        total: totalPortfolioValue,
        cash: newCashBalance,
        investments: rebalancedInvestments,
        weights: TARGET_WEIGHTS,
      },
    });
  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error("Rebalance error:", err);
    await trackEvent("wealth_management_pro.rebalance.failure", customerId || "unknown", tenantId, {
      feature: "wealth-management-pro", status: "error",
      error_msg: String(err), response_time_ms: responseTime,
    }, undefined, 'enterprise').catch(() => { });
    res.status(500).json({ error: "Rebalance failed" });
  }
};

// ═══════════════════════════════════════════════════════════════
// ─── PAYROLL PRO ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// GET /pro/payroll_payees — Returns current user's payees for selection
export const getPayrollPayees = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";

  if (!customerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payees = await prisma.payee.findMany({
      where: { payerCustomerId: customerId },
      include: {
        payeeAccount: {
          select: { accNo: true, ifsc: true, accountType: true, balance: true }
        }
      },
    });

    await trackEvent("bulk_payroll_processing.payees.view", customerId, tenantId, {
      feature: "bulk-payroll-processing",
      payees_count: payees.length,
      status: "success",
      response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise').catch(() => { });

    res.status(200).json(payees);
  } catch (err) {
    console.error("Payroll payees error:", err);
    res.status(500).json({ error: "Failed to fetch payees" });
  }
};

// POST /pro/search_payees — Search banking customers to add as payroll payees
export const searchPayrollPayees = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";
  const { query } = req.body;

  if (!customerId || !query || query.length < 2) {
    res.status(400).json({ error: "Search query too short (min 2 chars)" });
    return;
  }

  try {
    const results = await prisma.customer.findMany({
      where: {
        id: { not: customerId },
        name: { contains: query, mode: "insensitive" },
      },
      select: {
        id: true,
        name: true,
        account: {
          select: { accNo: true, ifsc: true },
          take: 1,
        },
      },
      take: 10,
    });

    const formatted = results
      .filter(r => r.account.length > 0)
      .map(r => ({
        customerId: r.id,
        name: r.name,
        accNo: r.account[0].accNo,
        ifsc: r.account[0].ifsc,
      }));

    await trackEvent("bulk_payroll_processing.search.success", customerId, tenantId, {
      feature: "bulk-payroll-processing",
      query_length: query.length,
      results_count: formatted.length,
      status: "success",
      response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise').catch(() => { });

    res.status(200).json(formatted);
  } catch (err) {
    console.error("Search payees error:", err);
    res.status(500).json({ error: "Search failed" });
  }
};

// POST /pro/process_payroll — Mass payment to multiple payees
export const processPayroll = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const customerId = (req as AuthenticatedRequest).user?.id;
  const tenantId = (req as AuthenticatedRequest).user?.tenantId || "bank_a";
  const { payees, amountPerPayee } = req.body as {
    payees: Array<{ accNo: string; name: string }>;
    amountPerPayee: number;
  };

  // ── Validations ──
  if (!customerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!payees || !Array.isArray(payees) || payees.length === 0) {
    await trackEvent("bulk_payroll_processing.batch.failure", customerId, tenantId, {
      feature: "bulk-payroll-processing", status: "error", error: "no_payees",
      response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise').catch(() => { });
    res.status(400).json({ error: "No payees selected" });
    return;
  }

  if (payees.length > 20) {
    await trackEvent("bulk_payroll_processing.batch.failure", customerId, tenantId, {
      feature: "bulk-payroll-processing", status: "error", error: "too_many_payees",
      payees_count: payees.length, response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise').catch(() => { });
    res.status(400).json({ error: "Maximum 20 payees per batch" });
    return;
  }

  if (!amountPerPayee || amountPerPayee <= 0) {
    res.status(400).json({ error: "Amount must be greater than 0" });
    return;
  }

  if (amountPerPayee > 10000) {
    await trackEvent("bulk_payroll_processing.batch.failure", customerId, tenantId, {
      feature: "bulk-payroll-processing", status: "error", error: "amount_exceeded",
      amountPerPayee, response_time_ms: Date.now() - startTime,
    }, undefined, 'enterprise').catch(() => { });
    res.status(400).json({ error: "Maximum ₹10,000 per payee per batch" });
    return;
  }

  const totalAmount = amountPerPayee * payees.length;

  try {
    // Verify license
    const license = await prisma.userLicense.findFirst({
      where: { customerId, featureId: "bulk-payroll-processing", active: true, expiryDate: { gt: new Date() } }
    });
    if (!license) {
      await trackEvent("bulk_payroll_processing.batch.failure", customerId, tenantId, {
        feature: "bulk-payroll-processing", status: "error", error: "no_license",
        response_time_ms: Date.now() - startTime,
      }, undefined, 'enterprise').catch(() => { });
      res.status(403).json({ error: "Active Payroll Pro license required." });
      return;
    }

    // Get sender account
    const account = await prisma.account.findFirst({
      where: { customerId, accountType: { in: ["SAVINGS", "CURRENT"] } },
      orderBy: { balance: "desc" }
    });

    if (!account) {
      res.status(404).json({ error: "No account found" });
      return;
    }

    if (account.balance < totalAmount) {
      await trackEvent("bulk_payroll_processing.batch.failure", customerId, tenantId, {
        feature: "bulk-payroll-processing", status: "error", error: "insufficient_funds",
        required: totalAmount, available: account.balance,
        response_time_ms: Date.now() - startTime,
      }, undefined, 'enterprise').catch(() => { });
      res.status(400).json({
        error: `Insufficient funds. Required: ₹${totalAmount.toLocaleString("en-IN")}, Available: ₹${account.balance.toLocaleString("en-IN")}`
      });
      return;
    }

    // Verify all payee accounts exist
    const payeeAccNos = payees.map(p => p.accNo);
    const validAccounts = await prisma.account.findMany({
      where: { accNo: { in: payeeAccNos } },
      select: { accNo: true },
    });
    const validAccNoSet = new Set(validAccounts.map(a => a.accNo));

    const invalidPayees = payees.filter(p => !validAccNoSet.has(p.accNo));
    if (invalidPayees.length > 0) {
      res.status(400).json({
        error: `Invalid payee accounts: ${invalidPayees.map(p => p.name).join(", ")}`,
      });
      return;
    }

    // Execute atomic batch payment
    const txOps: any[] = [];

    // Deduct total from sender
    txOps.push(
      prisma.account.update({
        where: { accNo: account.accNo },
        data: { balance: { decrement: totalAmount } },
      })
    );

    // Credit each payee and create transaction records
    for (const payee of payees) {
      txOps.push(
        prisma.account.update({
          where: { accNo: payee.accNo },
          data: { balance: { increment: amountPerPayee } },
        })
      );
      txOps.push(
        prisma.transaction.create({
          data: {
            transactionType: "PAYMENT",
            senderAccNo: account.accNo,
            receiverAccNo: payee.accNo,
            amount: amountPerPayee,
            status: "SUCCESS",
            category: "Payroll Batch",
            description: `Payroll to ${payee.name}`,
            channel: "WEB",
          },
        })
      );
    }

    await prisma.$transaction(txOps);

    const responseTime = Date.now() - startTime;
    await trackEvent("bulk_payroll_processing.batch.success", customerId, tenantId, {
      feature: "bulk-payroll-processing",
      payees_count: payees.length,
      amount_per_payee: amountPerPayee,
      total_amount: totalAmount,
      status: "success",
      response_time_ms: responseTime,
    }, undefined, 'enterprise');


    res.status(200).json({
      success: true,
      message: `Successfully paid ₹${amountPerPayee.toLocaleString("en-IN")} to ${payees.length} payees`,
      totalAmount,
      payeesProcessed: payees.length,
    });
  } catch (err) {
    const responseTime = Date.now() - startTime;
    console.error("Payroll error:", err);
    await trackEvent("bulk_payroll_processing.batch.failure", customerId || "unknown", tenantId, {
      feature: "bulk-payroll-processing", status: "error",
      error: String(err), response_time_ms: responseTime,
    }, undefined, 'enterprise').catch(() => { });
    res.status(500).json({ error: "Payroll processing failed" });
  }
};

// ─── Legacy download endpoint (redirect to access_book) ──────
export const downloadBook = accessBook;
