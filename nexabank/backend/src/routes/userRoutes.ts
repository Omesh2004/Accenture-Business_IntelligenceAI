import express, { Request, Response } from "express";
import {
  LoginController,
  RegisterController,
  EditPasswordController,
  EditUserController,
  GetProfileController,
} from "../controllers/UserControllers";
import {
  AddPayee,
  CheckPayeeName,
  deletePayee,
  EditPayee,
  fetchPayee,
  SearchPayees,
} from "../helper/payee";
import { CookieSend, isLoggedIn } from "../middleware/IsLoggedIn";

const router = express.Router();

// Public auth routes
router.get("/auth/cookieReturn", CookieSend);
router.post("/auth/login", LoginController);
router.post("/auth/register", RegisterController);
router.get("/auth/profile", isLoggedIn, GetProfileController);

// Protected auth routes
router.put("/auth/updatePassword", isLoggedIn, EditPasswordController);
router.put("/auth/updateUser", isLoggedIn, EditUserController);

// Logout route
router.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.status(200).json({ message: "Logged out successfully" });
});

// Payee routes (protected)
router.get("/payees/search", isLoggedIn, SearchPayees);
router.post("/payee/:payerCustomerId", isLoggedIn, AddPayee);
router.get("/payees/:payerCustomerId", isLoggedIn, fetchPayee);
router.put("/payee/:payerCustomerId", isLoggedIn, EditPayee);
router.delete("/payee/:payerCustomerId", isLoggedIn, deletePayee);
router.post("/payees/name", isLoggedIn, CheckPayeeName);
export default router;