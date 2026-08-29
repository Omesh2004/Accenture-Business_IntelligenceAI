"""
page_map.py — Centralised Feature → Page mapping for NexaBank & SafexBank.

Taxonomy convention: [page_name].[feature].[status]
  - page_name: dashboard | accounts | transactions | payees | loans | pro-feature | profile | admin_loans | admin_feature_toggles | admin_simulate | login | register
  - feature: overview | open_account | transfer_money | filter_by_date | add_payee | crypto-trading | etc...
  - status:  view | success | error | failed | action

"""

from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# TAXONOMY PAGE TO URL MAPPING
# Maps the taxonomy root [page_name] to the actual frontend URL.
# ─────────────────────────────────────────────────────────────────────────────
URL_MAP: dict[str, str] = {
    "dashboard": "/dashboard",
    "accounts": "/accounts",
    "transactions": "/transactions",
    "payees": "/payees",
    "loans": "/loans",
    "profile": "/profile",
    "admin_loans": "/admin/loans",
    "admin_feature_toggles": "/admin/feature-toggles",
    "admin_simulate": "/admin/simulate",
    "login": "/login",
    "register": "/register",
  
    # SafexBank additions
    "transfers": "/transfers",
    "approvals": "/approvals",
    "cards": "/cards",

    # Telemetry aliases that should resolve to physical NexaBank pages.
    "auth": "/login",
    "payment": "/transactions",
    "payments": "/transactions",
}

# ─────────────────────────────────────────────────────────────────────────────
# LEGACY FALLBACK MAP
# ─────────────────────────────────────────────────────────────────────────────
FEATURE_PAGE_MAP: dict[str, str] = {
    "login":                        "/login",
    "register":                     "/register",
    "dashboard_view":               "/dashboard",
    "page_view":                    "/dashboard",
    "view_dashboard":               "/dashboard",
    "accounts_view":                "/accounts",
    "transactions_view":            "/transactions",
    "payment_completed":            "/transactions",
    "payees_view":                  "/payees",
    "payee_added":                  "/payees",
    "loan_applied":                 "/loans",
    "loans_page_view":              "/loans",
    "crypto-trading":               "/pro-feature?id=crypto-trading",
    "crypto_trade_execution":       "/pro-feature?id=crypto-trading",
    "wealth-management-pro":        "/pro-feature?id=wealth-management-pro",
    "wealth_rebalance":             "/pro-feature?id=wealth-management-pro",
    "bulk-payroll-processing":      "/pro-feature?id=bulk-payroll-processing",
    "payroll_batch_processed":      "/pro-feature?id=bulk-payroll-processing",
    "ai-insights":                  "/pro-feature?id=ai-insights",
    "pro_book_download":            "/pro-feature?id=ai-insights",
    "kyc_completed":                "/loans",
    "kyc_started":                  "/loans",
    "transfer_funds":               "/accounts",
    "feature_view":                 "/dashboard",
    "pro_feature_usage":            "/dashboard",
    "location_captured":            "/dashboard",
    "admin_loans_view":             "/admin/loans",
    "admin_feature_toggles_view":   "/admin/feature-toggles",
    "admin_simulate_view":          "/admin/simulate",
}

# ─────────────────────────────────────────────────────────────────────────────
# MULTI-PAGE EVENTS
# ─────────────────────────────────────────────────────────────────────────────
FEATURE_MULTI_PAGE: dict[str, list[str]] = {
    "payees.pay_now.success":     ["/payees", "/transactions"],
    "loans.kyc.success":          ["/loans", "/profile"],
}

# ─────────────────────────────────────────────────────────────────────────────
# HUMAN-READABLE DISPLAY NAMES
# Maps explicit event paths to highly readable dashboard names.
# ─────────────────────────────────────────────────────────────────────────────
FEATURE_DISPLAY_NAMES: dict[str, str] = {
    # Dashboard
    "dashboard.page.view": "Dashboard View",
    "dashboard.overview.view": "Dashboard Overview",
    "dashboard.analytics_tab.view": "Dashboard Analytics",
    "dashboard.overview.error": "Dashboard Overview Error",
    "dashboard.analytics_tab.error": "Dashboard Analytics Error",
    "dashboard.location.captured": "Location Captured",  # Only in Dashboard, not Profile
    "dashboard.feature.view": "Feature View",
    "dashboard.feature.usage": "Feature Usage",

    # Accounts
    "accounts.page.view": "Accounts View",
    "account.page.view": "Accounts View",
    "accounts.open_account.success": "Account Opened",
    "accounts.open_account.failed": "Account Open Failed",
    "accounts.transfer_money.success": "Transfer Success",
    "accounts.transfer_money.failed": "Transfer Failed",
    "accounts.transfer_money.error": "Transfer Error",

    # Transactions
    "transactions.page.view": "Transactions View",
    "transaction.page.view": "Transactions View",
    "transactions.filter_by_date.success": "Transactions Filtered",
    "transaction.filter_by_date.success": "Transactions Filtered",
    "transaction.filter_by_date.failure": "Transactions Filter Failed",
    "transaction.history.view": "Transaction History Viewed",
    "transaction.search_transactions.success": "Transaction Searched",
    "transaction.search_transactions.failure": "Transaction Search Failed",
    "transaction.pay_now.success": "Payment Success",
    "transaction.pay_now.failure": "Payment Failed",
    "transaction.transfer.success": "Transfer Success",
    "transaction.transfer.failure": "Transfer Failed",
    "transactions.filter_by_date.failed": "Transactions Filter Failed",
    "transactions.history.view": "Transaction History Viewed",
    "transactions.search_transactions.success": "Transaction Searched",
    "transactions.search_transactions.failed": "Transaction Search Failed",
    "transactions.pay_now.success": "Payment Success",
    "transactions.pay_now.failed": "Payment Failed",

    # Payees
    "payees.page.view": "Payees View",
    "payee.page.view": "Payees View",
    "payees.add_payee.success": "Payee Added",
    "payee.add_payee.success": "Payee Added",
    "payees.add_payee.view": "Payee Add Viewed",
    "payee.add_payee.view": "Payee Add Viewed",
    "payees.add_payee.failed": "Payee Add Failed",
    "payee.add_payee.failure": "Payee Add Failed",
    "payees.edit_payee.success": "Payee Edited",
    "payee.edit_payee.success": "Payee Edited",
    "payees.edit_payee.failed": "Payee Edit Failed",
    "payee.edit_payee.failure": "Payee Edit Failed",
    "payees.remove_payee.success": "Payee Removed",
    "payee.remove_payee.success": "Payee Removed",
    "payees.remove_payee.failed": "Payee Remove Failed",
    "payee.remove_payee.failure": "Payee Remove Failed",
    "payees.search_payee.success": "Payee Searched",
    "payee.search_payee.success": "Payee Searched",
    "payees.search_payee.failed": "Payee Search Failed",
    "payee.search_payee.failure": "Payee Search Failed",
    "payees.copy_account_number.success": "Account Copied",
    "payee.copy_account_number.success": "Account Copied",
    "payees.copy_account_number.failed": "Account Copy Failed",
    "payee.copy_account_number.failure": "Account Copy Failed",
    "payees.pay_now.success": "Payment Success",
    "payee.pay_now.success": "Payment Success",
    "payees.pay_now.failed": "Payment Failed",
    "payee.pay_now.failure": "Payment Failed",

    # Loans
    "loans.page.view": "Loans View",
    "loan.page.view": "Loans View",
    "loans.emi_estimator.action": "EMI Calculated",
    "loans.apply_loan.action": "Loan Flow Started",
    "loans.proceed_to_kyc.action": "Loan KYC Started",
    "loans.kyc.success": "Loan KYC Completed",
    "loans.kyc.failed": "Loan KYC Failed",
    "loans.proceed_to_kyc.failed": "Loan KYC Start Failed",
    "loans.submit_application.success": "Loan App Submitted",
    "loan.applied.success": "Loan App Submitted",
    "loan.approved.success": "Loan Approved",
    "loan.kyc_started.success": "Loan KYC Started",
    "loan.kyc_completed.success": "Loan KYC Completed",
    "loan.kyc_failed.failure": "Loan KYC Failed",
    "loan.kyc_abandoned.failure": "Loan KYC Abandoned",
    "loans.submit_application.error": "Loan App Error",
    "loans.submit_application.failed": "Loan App Failed",
    "loans.kyc.abandoned": "Loan KYC Abandoned",

    # Pro Features - Main
    "pro-feature.page.view": "Pro Features View",
    "crypto-trading.page.view": "Crypto Trading View",
    "wealth-management-pro.page.view": "Wealth Management View",
    "bulk-payroll-processing.page.view": "Bulk Payroll View",
    "ai-insights.page.view": "AI Insights View",
    "pro.new_feature.view": "New Pro Feature View",
    "auth.role.violation": "Role Violation",

    # Pro Features - AI Insights
    "pro-feature.ai-insights.read_online": "AI Insights Read",
    "pro-feature.ai-insights.read_online.failed": "AI Insights Read Failed",
    "ai-insights.book.access": "AI Insights Book Access",
    "ai-insights.book.success": "AI Insights Book Access",
    "ai-insights.book.failure": "AI Insights Book Access Failed",
    "ai-insights.stats.view": "AI Insights Stats View",

    # Pro Features - Crypto Trading
    "pro-feature.crypto-trading.page_view": "Crypto Trading View",
    "pro-feature.crypto-trading.buy_success": "Crypto Bought",
    "pro-feature.crypto-trading.buy_failed": "Crypto Buy Failed",
    "pro-feature.crypto-trading.sell_success": "Crypto Sold",
    "pro-feature.crypto-trading.sell_failed": "Crypto Sell Failed",
    "crypto-trading.trade_execution.success": "Crypto Trade Execution",
    "crypto-trading.trade_execution.failure": "Crypto Trade Execution Failed",
    "crypto-trading.portfolio.view": "Crypto Portfolio View",
    "crypto-trading.price_feeds.view": "Crypto Price Feeds View",
    "crypto-trading.price_feeds.failure": "Crypto Price Feeds Failed",

    # Pro Features - Wealth Management
    "pro-feature.wealth-management-pro.insights_view": "Wealth Insights",
    "pro-feature.wealth-management-pro.insights_view.error": "Wealth Insights Error",
    "pro-feature.wealth-management-pro.insights_view.failed": "Wealth Insights Failed",
    "pro-feature.wealth-management-pro.rebalance_success": "Wealth Rebalanced",
    "pro-feature.wealth-management-pro.rebalance_failed": "Wealth Rebalance Failed",
    "wealth-management-pro.insights.view": "Wealth Insights",
    "wealth-management-pro.insights.failure": "Wealth Insights Failed",
    "wealth-management-pro.rebalance.success": "Wealth Rebalanced",
    "wealth-management-pro.rebalance.failure": "Wealth Rebalance Failed",

    # Pro Features - Bulk Payroll
    "pro-feature.bulk-payroll-processing.page_view": "Bulk Payroll View",
    "pro-feature.bulk-payroll-processing.search_by_name": "Payroll Searched",
    "pro-feature.bulk-payroll-processing.search_by_name.failed": "Payroll Search Failed",
    "pro-feature.bulk-payroll-processing.add_payee": "Payroll Payee Added",
    "pro-feature.bulk-payroll-processing.add_payee.failed": "Payroll Payee Add Failed",
    "pro-feature.bulk-payroll-processing.pay_all_success": "Bulk Payroll Success",
    "pro-feature.bulk-payroll-processing.pay_all_failed": "Bulk Payroll Failed",
    "bulk-payroll-processing.batch.success": "Bulk Payroll Success",
    "bulk-payroll-processing.batch.failure": "Bulk Payroll Failed",
    "bulk-payroll-processing.payees.view": "Payroll Payee List",
    "bulk-payroll-processing.search.success": "Payroll Search",
    "bulk-payroll-processing.search.failure": "Payroll Search Failed",

    # Profile (NO Location here - only in Dashboard)
    "profile.page.view": "Profile View",
    "profile.view": "Profile View",
    "profile.edit_details.success": "Profile Details Edited",
    "profile.edit_details.failed": "Profile Details Edit Failed",
    "profile.edit_details.error": "Profile Details Edit Error",

    # Admin
    "admin_loans.page.view": "Admin Loans View",
    "admin_loans.view_details.view": "Admin Loan Details",
    "admin_loans.approve.success": "Loan Approved",
    "admin_loans.approve.failed": "Loan Approve Failed",
    "admin_loans.reject.success": "Loan Rejected",
    "admin_loans.reject.failed": "Loan Reject Failed",
    "admin_feature_toggles.page.view": "Admin Toggles View",
    "admin_feature_toggles.toggle_feature.success": "Feature Toggled",
    "admin_feature_toggles.toggle_feature.failed": "Feature Toggle Failed",
    "admin_simulate.page.view": "Admin Simulator View",
    "admin_simulate.run_simulation.success": "Simulation Run",
    "admin_simulate.run_simulation.failed": "Simulation Failed",

    # Auth
    "login.page.view": "Login Page",
    "login.auth.success": "Login Success",
    "login.auth.failed": "Login Failed",
    "login.auth.error": "Login Error",
    "register.page.view": "Register Page",
    "register.auth.success": "Register Success",
    "register.auth.failed": "Register Failed",
    "register.auth.error": "Register Error",
}

# ─────────────────────────────────────────────────────────────────────────────
# HELPER FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

def normalize_event(event_name: str) -> str:
    """
    Centralized normalization layer.
    Maps all raw events into canonical feature IDs.
    Format: [domain].[feature].[status]
    """
    if not event_name:
        return "core.unknown.view"
        
    e = event_name.lower().strip()
    
    # 1. Map known duplicates & synonyms (comprehensive mapping to eliminate all variants)
    mapping = {
        # Dashboard page variants
        "page_view": "dashboard.page.view",
        "dashboard_view": "dashboard.page.view",
        "view_dashboard": "dashboard.page.view",
        "core.dashboard.view": "dashboard.page.view",
        "dashboard.dashboard_view.view": "dashboard.page.view",
        "dashboard.dashboard.view": "dashboard.page.view",
        "free.dashboard.view": "dashboard.page.view",
        
        # Location (Dashboard only - NOT Profile)
        "location_captured": "dashboard.location.captured",
        "core.location.captured": "dashboard.location.captured",
        "core.location_captured.action": "dashboard.location.captured",
        "free.profile.location": "dashboard.location.captured",
        
        # Accounts
        "accounts_view": "accounts.page.view",
        "free.accounts.view": "accounts.page.view",
        "core.accounts.view": "accounts.page.view",
        
        # Transactions & Payment related
        "transactions_view": "transactions.page.view",
        "free.transactions.view": "transactions.page.view",
        "core.transactions.view": "transactions.page.view",
        "payment_completed": "transactions.pay_now.success",
        "free.payment.success": "transactions.pay_now.success",
        "core.payment.success": "transactions.pay_now.success",
        "payment_failed": "transactions.pay_now.failed",
        "free.payment.failed": "transactions.pay_now.failed",
        "core.payment.failed": "transactions.pay_now.failed",
        "payments.history.viewed": "transactions.history.view",
        "payees": "payees.page.view",  # Changed to page.view for consistency
        
        # Payees variants
        "payees_view": "payees.page.view",
        "free.payees.view": "payees.page.view",
        "core.payees.view": "payees.page.view",
        "payees.pay_now.success": "payees.pay_now.success",  # Already canonical
        "payees.pay_now.failed": "payees.pay_now.failed",    # Missing but needed
        "free.payees.add.success": "payees.add_payee.success",
        "core.payee_added.view": "payees.add_payee.view",
        
        # Loans & KYC related
        "loan_applied": "loans.applied.success",
        "loan_approved": "loans.approved.success",
        "kyc_abandoned": "loans.kyc.abandoned",
        "kyc_started": "loans.proceed_to_kyc.action",
        "kyc_completed": "loans.submit_application.success",
        "free.loan.kyc_started": "loans.proceed_to_kyc.action",
        "free.loan.kyc_completed": "loans.kyc.success",
        "free.loan.kyc_failed": "loans.kyc.failed",
        "free.loan.kyc_started.action": "loans.proceed_to_kyc.action",
        "free.loan.applied.action": "loans.submit_application.success",
        "free.loan.kyc_abandoned.action": "loans.kyc.abandoned",
        "core.kyc_abandoned.view": "loans.kyc.abandoned",
        "core.profile.viewed": "profile.page.view",
        "profile.view": "profile.page.view",
        "free.profile.view": "profile.page.view",
        "core.loan.applied.action": "loans.submit_application.success",
        "core.loan.kyc_started.action": "loans.proceed_to_kyc.action",
        "lending.loan.applied.action": "loans.submit_application.success",
        "lending.loan.applied": "loans.submit_application.success",
        "lending.loan.kyc_started.action": "loans.proceed_to_kyc.action",
        "lending.loans.viewed": "loans.page.view",
        "lending.loan.kyc_abandoned.action": "loans.kyc.abandoned",
        "lending.loan.kyc_abandoned": "loans.kyc.abandoned",
        "lending.loan.kyc_completed": "loans.kyc.success",
        
        # Pro Features - Crypto Trading
        "crypto_trading": "pro-feature.crypto-trading.page_view",
        "crypto_trade_execution": "pro-feature.crypto-trading.buy_success",
        "pro.crypto_trade_execution.success": "pro-feature.crypto-trading.buy_success",
        "pro.crypto_portfolio.view": "pro-feature.crypto-trading.page_view",
        "core.crypto_trading.view": "pro-feature.crypto-trading.page_view",
        "core.crypto.buy.success": "pro-feature.crypto-trading.buy_success",
        "crypto-trading": "pro-feature.crypto-trading.page_view",
        
        # Pro Features - AI Insights
        "ai_insights": "pro-feature.ai-insights.read_online",
        "pro_book_download": "pro-feature.ai-insights.read_online",
        "core.ai_insights.view": "pro-feature.ai-insights.read_online",
        "ai-insights": "pro-feature.ai-insights.read_online",
        
        # Pro Features - Wealth Management
        "wealth_management_pro": "pro-feature.wealth-management-pro.insights_view",
        "wealth_rebalance": "wealth_management_pro.rebalance.success",
        "core.wealth_management_pro.view": "pro-feature.wealth-management-pro.insights_view",
        "pro.wealth.rebalance.success": "pro-feature.wealth-management-pro.rebalance_success",
        "wealth-management-pro": "pro-feature.wealth-management-pro.insights_view",
        
        # Pro Features - Bulk Payroll
        "bulk_payroll_processing": "bulk_payroll_processing.batch.success",
        "payroll_batch_processed": "pro-feature.bulk-payroll-processing.pay_all_success",
        "core.bulk_payroll_processing.view": "pro-feature.bulk-payroll-processing.page_view",
        "pro.payroll_batch.success": "pro-feature.bulk-payroll-processing.pay_all_success",
        "pro.payroll.batch.success": "pro-feature.bulk-payroll-processing.pay_all_success",
        "bulk-payroll-processing": "pro-feature.bulk-payroll-processing.page_view",
        
        # Pro Features - General
        "pro_unlocked": "pro.features_unlock.success",
        "pro_license_unlocked": "pro.features_unlock.success",
        "core.pro_unlocked.view": "pro.features_unlock.success",
        "core.pro_license_unlocked.view": "pro.features_unlock.success",
        
        # Profile (Location NOT here - only in Dashboard)
        "profile.edit_profile.success": "profile.edit_details.success",
        "profile.edit_profile.error": "profile.edit_details.error",
        "profile.edit_profile.failed": "profile.edit_details.error",
        "free.profile.view": "profile.page.view",
        "core.profile.view": "profile.page.view",
        "core.profile.viewed.action": "profile.page.view",
        
        # Auth
        "free.auth.login.success": "login.auth.success",
        
        # Other
        "transfer_funds": "accounts.transfer_money.success",
        "feature_view": "dashboard.feature.view",
        "pro_feature_usage": "dashboard.feature.usage",
    }
    
    if e in mapping:
        return mapping[e]

    # 1b. Normalize known malformed variants from mixed simulators/trackers.
    if e == "dashboard.dashboard_view.view":
        return "dashboard.page.view"
    if e == "core.dashboard.view":
        return "dashboard.page.view"

    # 2. Heuristic suffix normalizations
    if e.endswith("_success"):
        e = e.replace("_success", ".success")
    elif e.endswith("_error"):
        e = e.replace("_error", ".error")
    elif e.endswith("_failed"):
        e = e.replace("_failed", ".failed")
    elif e.endswith("_failure"):
        e = e.replace("_failure", ".failed")
    elif e.endswith("_view"):
        e = e.replace("_view", ".view")
    elif e.endswith("_action"):
        e = e.replace("_action", ".action")
    elif e.endswith("_response_time"):
        e = e.replace("_response_time", ".response_time")

    # 2b. Collapse common duplicate suffix patterns into canonical events.
    e = e.replace(".page_view", ".page.view")
    if e.endswith(".dashboard_view.view"):
        e = e.replace(".dashboard_view.view", ".page.view")

    # 2c. Legacy core.* guards with fuzzy matching for simulator variants.
    if e.startswith("core.kyc_abandoned"):
        return "loans.kyc.abandoned"
    if e.startswith("core.crypto_trading"):
        return "pro-feature.crypto-trading.page_view"
    if e.startswith("core.ai_insights"):
        return "pro-feature.ai-insights.read_online"
    if e.startswith("core.pro_unlocked") or e.startswith("core.pro_license_unlocked"):
        return "pro.features_unlock.success"

    # 3. Taxonomy enforcer
    if "." not in e:
        e = f"core.{e}.view"
        
    return e


CANONICAL_EVENT_ALIASES: dict[str, str | None] = {
    "free.dashboard.view": "dashboard.page.view",
    "core.dashboard.view": "dashboard.page.view",
    "dashboard.view.action": "dashboard.page.view",
    "core.login.view": "login.page.view",
    "auth.login.success": "login.auth.success",
    "core.register.view": "register.page.view",
    "free.auth.register.success": "register.auth.success",
    "location_captured": "dashboard.location.captured",
    "core.location.captured": "dashboard.location.captured",
    "core.location_captured.action": "dashboard.location.captured",
    "free.profile.location": "dashboard.location.captured",
    "free.accounts.view": "account.page.view",
    "core.accounts.view": "account.page.view",
    "free.transactions.view": "transaction.page.view",
    "core.transactions.view": "transaction.page.view",
    "free.payment.success": "transaction.pay_now.success",
    "core.payment.success": "transaction.pay_now.success",
    "free.payment.failed": "transaction.pay_now.failure",
    "core.payment.failed": "transaction.pay_now.failure",
    "payment_completed": "transaction.pay_now.success",
    "payment_failed": "transaction.pay_now.failure",
    "transfer_completed": "transaction.transfer.success",
    "transfer_failed": "transaction.transfer.failure",
    "transactions.transfer.success": "transaction.transfer.success",
    "transactions.transfer.failed": "transaction.transfer.failure",
    "payments.history.viewed": "transaction.history.view",
    "free.payees.view": "payee.page.view",
    "core.payees.view": "payee.page.view",
    "payees_view": "payee.page.view",
    "payees": "payee.page.view",
    "free.payees.add.success": "payee.add_payee.success",
    "free.payees.add_failed": "payee.add_payee.failure",
    "free.payees.edit_success": "payee.edit_payee.success",
    "free.payees.edit_failed": "payee.edit_payee.failure",
    "free.payees.delete_success": "payee.remove_payee.success",
    "free.payees.delete_failed": "payee.remove_payee.failure",
    "core.payee_added.view": "payee.add_payee.view",
    "free.loan.applied": "loan.applied.success",
    "loan_applied": "loan.applied.success",
    "loans.applied.success": "loan.applied.success",
    "free.loan.applied.action": "loan.applied.success",
    "core.loan.applied.action": "loan.applied.success",
    "lending.loan.applied": "loan.applied.success",
    "lending.loan.applied.action": "loan.applied.success",
    "free.loan.kyc_started": "loan.kyc_started.success",
    "free.loan.kyc_started.action": "loan.kyc_started.success",
    "loan.proceed_to_kyc.success": "loan.kyc_started.success",
    "loans.proceed_to_kyc.success": "loan.kyc_started.success",
    "loans.proceed_to_kyc.action": "loan.kyc_started.success",
    "core.loan.kyc_started.action": "loan.kyc_started.success",
    "lending.loan.kyc_started": "loan.kyc_started.success",
    "lending.loan.kyc_started.action": "loan.kyc_started.success",
    "free.loan.kyc_completed": "loan.kyc_completed.success",
    "lending.loan.kyc_completed": "loan.kyc_completed.success",
    "kyc_completed": "loan.kyc_completed.success",
    "loan_approved": "loan.approved.success",
    "loans.approved.success": "loan.approved.success",
    "free.loan.kyc_failed": "loan.kyc_failed.failure",
    "core.loan_approved.view": "loan.approved.view",
    "free.loan.kyc_abandoned.action": "loan.kyc_abandoned.failure",
    "lending.loan.kyc_abandoned": "loan.kyc_abandoned.failure",
    "lending.loan.kyc_abandoned.action": "loan.kyc_abandoned.failure",
    "kyc_abandoned": "loan.kyc_abandoned.failure",
    "core.kyc_abandoned.view": "loan.kyc_abandoned.failure",
    "core.profile.viewed": "profile.page.view",
    "free.profile.view": "profile.page.view",
    "profile.view": "profile.page.view",
    "core.register.view": "register.page.view",
    "free.register.view": "register.page.view",
    "pro.dashboard.view": "dashboard.page.view",
    "loan_page.view": "loan.page.view",
    "pro.crypto_trade_execution.success": "crypto-trading.trade_execution.success",
    "pro.crypto_trade_execution.failed": "crypto-trading.trade_execution.failure",
    "pro.crypto_trade_execution.failure": "crypto-trading.trade_execution.failure",
    "crypto_trading.trade_execution.success": "crypto-trading.trade_execution.success",
    "crypto_trading.trade_execution.failed": "crypto-trading.trade_execution.failure",
    "crypto_trading.trade_execution.failure": "crypto-trading.trade_execution.failure",
    "pro-feature.crypto-trading.buy_success": "crypto-trading.trade_execution.success",
    "pro-feature.crypto-trading.buy_failed": "crypto-trading.trade_execution.failure",
    "pro-feature.crypto-trading.page_view": "crypto-trading.page.view",
    "crypto_trading.page.view": "crypto-trading.page.view",
    "pro.crypto_portfolio.view": "crypto-trading.portfolio.view",
    "crypto_trading.portfolio.view": "crypto-trading.portfolio.view",
    "pro.crypto_price_feeds.view": "crypto-trading.price_feeds.view",
    "crypto_trading.price_feeds.failure": "crypto-trading.price_feeds.failure",
    "wealth_management_pro.insights.failure": "wealth-management-pro.insights.failure",
    "ai_insights.book.failure": "ai-insights.book.failure",
    "new_feature.view.action": "pro.new_feature.view",
    "crypto_trading.price_feeds.view": "crypto-trading.price_feeds.view",
    "core.crypto_trading.view": "crypto-trading.page.view",
    "crypto_trading": "crypto-trading.page.view",
    "crypto-trading": "crypto-trading.page.view",
    "pro.wealth_insights.view": "wealth-management-pro.insights.view",
    "pro-feature.wealth-management-pro.insights_view": "wealth-management-pro.insights.view",
    "pro-feature.wealth-management-pro.rebalance_success": "wealth-management-pro.rebalance.success",
    "pro.wealth_rebalance.success": "wealth-management-pro.rebalance.success",
    "wealth_management_pro.rebalance.success": "wealth-management-pro.rebalance.success",
    "wealth_management_pro": "wealth-management-pro.page.view",
    "wealth_rebalance": "wealth-management-pro.rebalance.success",
    "wealth-management-pro": "wealth-management-pro.page.view",
    "pro.payroll_batch.success": "bulk-payroll-processing.batch.success",
    "bulk_payroll_processing.batch.success": "bulk-payroll-processing.batch.success",
    "pro-feature.bulk-payroll-processing.pay_all_success": "bulk-payroll-processing.batch.success",
    "pro-feature.bulk-payroll-processing.page_view": "bulk-payroll-processing.page.view",
    "pro.payroll_search.success": "bulk-payroll-processing.search.success",
    "pro.payroll_payees.view": "bulk-payroll-processing.payees.view",
    "bulk_payroll_processing": "bulk-payroll-processing.page.view",
    "bulk-payroll-processing": "bulk-payroll-processing.page.view",
    "pro.finance_library_book.access": "ai-insights.book.success",
    "pro-feature.ai-insights.read_online": "ai-insights.book.success",
    "pro-feature.ai-insights.page_view": "ai-insights.page.view",
    "pro.finance_library_stats.view": "ai-insights.stats.view",
    "ai_insights": "ai-insights.page.view",
    "ai-insights": "ai-insights.page.view",
    "pro.features.view": None,
    "pro-feature.page.view": None,
    "pro.features_unlock.success": None,
    "pro.features_unlock.failed": None,
    "pro_unlocked": None,
    "pro_license_unlocked": None,
}


def canonicalize_event_name(event_name: str) -> Optional[str]:
    """Return a single canonical [page_name].[feature].[status] string or None."""
    if not event_name:
        return None

    raw = event_name.lower().strip()
    normalized = normalize_event(raw)
    if normalized in CANONICAL_EVENT_ALIASES:
        return CANONICAL_EVENT_ALIASES[normalized]
    if raw in CANONICAL_EVENT_ALIASES:
        return CANONICAL_EVENT_ALIASES[raw]

    parts = normalized.split(".")
    while parts and parts[0] in {"core", "free", "pro", "enterprise", "lending"}:
        parts = parts[1:]

    if not parts:
        return None

    page = {
        "accounts": "account",
        "transactions": "transaction",
        "payees": "payee",
        "loans": "loan",
    }.get(parts[0], parts[0])

    page = {
        "crypto_trading": "crypto-trading",
        "wealth_management_pro": "wealth-management-pro",
        "bulk_payroll_processing": "bulk-payroll-processing",
        "ai_insights": "ai-insights",
    }.get(page, page)

    remainder = parts[1:]
    if page == "payee":
        if not remainder:
            return "payee.page.view"
        feature = remainder[0]
        if feature == "add":
            feature = "add_payee"
        elif feature in {"delete", "remove"}:
            feature = "remove_payee"
        elif feature == "edit":
            feature = "edit_payee"
        elif feature == "search":
            feature = "search_payee"
        elif feature == "copy":
            feature = "copy_account_number"
        elif feature in {"pay", "payment", "pay_now"}:
            feature = "pay_now"
        elif feature in {"view", "viewed"}:
            return "payee.page.view"

        status = remainder[1] if len(remainder) > 1 else "success"
        if status in {"error", "failed", "fail"}:
            status = "failure"
        elif status == "viewed":
            status = "view"
        elif status not in {"view", "success", "failure"}:
            status = "success"
        return f"payee.{feature}.{status}"

    if page == "transaction":
        if not remainder:
            return "transaction.page.view"
        feature = remainder[0]
        if feature in {"view", "viewed", "page"}:
            return "transaction.page.view"
        if feature == "history":
            return "transaction.history.view"
        if feature in {"pay", "payment", "pay_now"}:
            feature = "pay_now"
        elif feature == "filter_by_date":
            feature = "filter_by_date"
        elif feature in {"search", "search_transactions"}:
            feature = "search_transactions"

        status = remainder[1] if len(remainder) > 1 else "success"
        if status in {"error", "failed", "fail"}:
            status = "failure"
        elif status == "viewed":
            status = "view"
        elif status not in {"view", "success", "failure"}:
            status = "success"
        return f"transaction.{feature}.{status}"

    if page == "account":
        if not remainder:
            return "account.page.view"
        feature = remainder[0]
        if feature in {"view", "viewed", "page"}:
            return "account.page.view"
        if feature == "open_account":
            feature = "open_account"
        elif feature == "transfer_money":
            feature = "transfer_money"

        status = remainder[1] if len(remainder) > 1 else "success"
        if status in {"error", "failed", "fail"}:
            status = "failure"
        elif status == "viewed":
            status = "view"
        elif status not in {"view", "success", "failure"}:
            status = "success"
        return f"account.{feature}.{status}"

    if page == "loan":
        if not remainder:
            return "loan.page.view"
        feature = remainder[0]
        if feature in {"view", "viewed", "page"}:
            return "loan.page.view"

        status = remainder[1] if len(remainder) > 1 else "success"
        if status in {"error", "failed", "fail"}:
            status = "failure"
        elif status == "viewed":
            status = "view"
        elif status not in {"view", "success", "failure"}:
            status = "success"
        return f"loan.{feature}.{status}"

    if page == "profile":
        if not remainder:
            return "profile.page.view"
        feature = remainder[0]
        if feature in {"view", "viewed", "page"}:
            return "profile.page.view"
        if feature == "edit_details":
            status = remainder[1] if len(remainder) > 1 else "success"
            if status in {"error", "failed", "fail"}:
                status = "failure"
            elif status not in {"view", "success", "failure"}:
                status = "success"
            return f"profile.edit_details.{status}"

    if page in {"crypto-trading", "wealth-management-pro", "bulk-payroll-processing", "ai-insights"}:
        if not remainder:
            return f"{page}.page.view"
        feature = remainder[0]
        if feature in {"view", "viewed", "page"}:
            return f"{page}.page.view"
        status = remainder[1] if len(remainder) > 1 else "success"
        if status in {"error", "failed", "fail"}:
            status = "failure"
        elif status == "viewed":
            status = "view"
        elif status not in {"view", "success", "failure"}:
            status = "success"
        return f"{page}.{feature}.{status}"

    return normalized

def resolve_page(event_name: str) -> Optional[str]:
    """
    Resolve an event_name to its canonical page URL.
    Parses strict taxonomy [page_name].[feature].[status] directly.
    """
    if not event_name:
        return None

    # 1. Check legacy/explicit map
    if event_name in FEATURE_PAGE_MAP:
        return FEATURE_PAGE_MAP[event_name]

    # 2. Strict taxonomy parsing
    parts = event_name.split(".")
    if len(parts) >= 2:
        page_root = parts[0]
        singular_aliases = {
            "account": "accounts",
            "transaction": "transactions",
            "payee": "payees",
            "loan": "loans",
        }
        page_root = singular_aliases.get(page_root, page_root)

        # Handle malformed telemetry roots like "loan/page" or "loans/page".
        if "/" in page_root:
            base_root = page_root.split("/")[0]
            if base_root in URL_MAP:
                return URL_MAP[base_root]

        # Handle normalized telemetry domains that are not physical routes.
        if page_root in {"core", "free"} and len(parts) >= 2:
            second = parts[1]
            if second in URL_MAP:
                return URL_MAP[second]
            if second == "auth":
                # Default auth events to login unless explicitly register.
                if len(parts) >= 3 and parts[2] == "register":
                    return "/register"
                return "/login"
            if second in {"payment", "payments"}:
                return "/transactions"
            if "loan" in second or "lending" in second:
                return "/loans"
            if "account" in second:
                return "/accounts"
            if "transaction" in second or "payment" in second:
                return "/transactions"
            if "payee" in second:
                return "/payees"
            if "profile" in second:
                return "/profile"
            if "register" in second or "signup" in second:
                return "/register"
            if "login" in second or "auth" in second:
                return "/login"
            if "dashboard" in second or "home" in second:
                return "/dashboard"
            return "/dashboard"

        if page_root == "pro" and len(parts) >= 2:
            second = parts[1]
            if second.startswith("crypto"):
                return "/pro-feature?id=crypto-trading"
            if second.startswith("wealth"):
                return "/pro-feature?id=wealth-management-pro"
            if second.startswith("payroll"):
                return "/pro-feature?id=bulk-payroll-processing"
            if second.startswith("finance"):
                return "/pro-feature?id=ai-insights"
            return None

        if page_root in {"crypto-trading", "wealth-management-pro", "bulk-payroll-processing", "ai-insights"}:
            return f"/pro-feature?id={page_root}"
        
        # Handle dynamic query param pro-feature URL routing
        if page_root == "pro-feature" and len(parts) >= 3:
            second = parts[1]
            if second in {"crypto-trading", "wealth-management-pro", "bulk-payroll-processing", "ai-insights"}:
                return f"/pro-feature?id={second}"
            return None
        if page_root == "pro-feature":
            return None
            
        # Map roots like admin_loans to /admin/loans
        if page_root in URL_MAP:
            return URL_MAP[page_root]
        
        # Fallback to direct routing for unknown roots
        clean_root = page_root.replace('_', '/')
        return f"/{clean_root}"

    # 3. Give up -> will be filed under /_other
    return None


def resolve_display_name(event_name: str) -> str:
    """
    Returns a human-readable display name for an event.
    Automatically formats unknown taxonomy paths beautifully.
    """
    if not event_name:
        return "Unknown"

    name = FEATURE_DISPLAY_NAMES.get(event_name)
    if name:
        return name

    # Fallback formatter: page.feature.status -> "Page: Feature (Status)"
    parts = event_name.replace("-", "_").split(".")
    if len(parts) == 3:
        page_name = parts[0].replace("_", " ").title()
        feature = parts[1].replace("_", " ").title()
        status = parts[2].title()
        return f"{page_name}: {feature} ({status})"
    elif len(parts) == 2:
        page_name = parts[0].replace("_", " ").title()
        feature = parts[1].replace("_", " ").title()
        return f"{page_name}: {feature}"

    return event_name.replace("_", " ").title()
