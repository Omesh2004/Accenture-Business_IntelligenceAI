import express from "express";
import { body } from "express-validator";
import * as accountController from "../controllers/accountController";

const router = express.Router();

router.post(
  "/accounts",
  [
    body("customerId").isUUID(),
    body("ifsc").isString().notEmpty(),
    body("accountType").isIn([
      "SAVINGS",
      "CURRENT",
      "LOAN",
      "CREDIT_CARD",
      "INVESTMENT",
    ]),
    body("balance").isFloat({ min: 0 }).optional(),
  ],
  accountController.createAccount
);

// GET endpoint to fetch account by ID
router.get("/accounts/:id", accountController.getAccountById);

// GET endpoint to fetch all accounts for a customer
router.get(
  "/customers/accounts/:customerId",
  accountController.getAccountsByCustomerId
);

// POST endpoint to transfer money between own accounts
router.post(
  "/accounts/transfer",
  [
    body("fromAccountNo").isString().notEmpty(),
    body("toAccountNo").isString().notEmpty(),
    body("amount").isFloat({ min: 0.01 }),
    body("description").isString().optional(),
  ],
  accountController.transferBetweenOwnAccounts
);

// POST endpoint to pay a payee (cross-customer allowed)
router.post(
  "/accounts/pay",
  [
    body("fromAccountNo").isString().notEmpty(),
    body("toAccountNo").isString().notEmpty(),
    body("amount").isFloat({ min: 0.01 }),
    body("description").isString().optional(),
  ],
  accountController.payToPayee
);

export default router;
