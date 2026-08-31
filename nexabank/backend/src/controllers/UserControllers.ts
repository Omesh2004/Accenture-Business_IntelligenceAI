import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { trackEvent } from "../middleware/eventTracker";

// Zod schemas with strict typing
const registerSchema = z.object({
  name: z
    .string()
    .min(2, { message: "Name must be at least 2 characters long" }),
  email: z.string().email({ message: "Invalid email address" }),
  phone: z
    .string()
    .min(10, { message: "Phone number must be at least 10 digits long" }),
  password: z
    .string()
    .min(8, { message: "Password must be at least 8 characters long" }),
  dateOfBirth: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: "Invalid date format",
  }),
  pan: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, { message: "Invalid PAN format" }),
  tenantId: z.string().optional().default("bank_a"),
  settingConfig: z.record(z.unknown()).optional().default({}),
  address: z.record(z.unknown()).optional().default({}),
});

const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z
    .string()
    .min(8, { message: "Password must be at least 8 characters long" }),
});

const editUserSchema = z.object({
  id: z.string().uuid({ message: "Invalid user ID" }),
  name: z
    .string()
    .min(2, { message: "Name must be at least 2 characters long" })
    .optional(),
  email: z.string().email({ message: "Invalid email address" }).optional(),
  phone: z
    .string()
    .min(10, { message: "Phone number must be at least 10 digits long" })
    .optional(),
  dateOfBirth: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "Invalid date format",
    })
    .optional(),
  pan: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, { message: "Invalid PAN format" })
    .optional(),
  settingConfig: z.record(z.unknown()).optional(),
  address: z.record(z.unknown()).optional(),
});

const editPasswordSchema = z.object({
  id: z.string().uuid({ message: "Invalid user ID" }),
  oldPassword: z.string().min(1, { message: "Old password is required" }),
  newPassword: z
    .string()
    .min(8, { message: "New password must be at least 8 characters long" }),
});

// Generate a fingerprint for the client based on headers and IP
function generateClientFingerprint(req: Request): string {
  const userAgent = req.headers["user-agent"] || "";
  const ip = req.ip || req.socket.remoteAddress || "";
  const rawFingerprint = `${ip}:${userAgent}`;

  let hash = 0;
  for (let i = 0; i < rawFingerprint.length; i++) {
    const char = rawFingerprint.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  return hash.toString();
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SEC;
  if (!secret) {
    throw new Error("JWT_SEC is not defined");
  }
  return secret;
}

function createTokenAndCookie(
  res: Response,
  userId: string,
  fingerprint: string
): void {
  const token = jwt.sign({ userId, fingerprint }, getJwtSecret(), {
    expiresIn: "12h",
  });

  res.cookie("token", token, {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
}

export const LoginController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    res.status(400).json({ errors });
    return;
  }

  const { email, password } = parseResult.data;

  try {
    const user = await prisma.customer.findUnique({
      where: { email },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    const fingerprint = generateClientFingerprint(req);
    createTokenAndCookie(res, user.id, fingerprint);

    // Update lastLogin timestamp for retention analytics
    await prisma.customer.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    await trackEvent("auth.login.success", user.id, user.tenantId || "bank_a", { ip: req.ip, device_type: "web" });

    res.status(200).json({ userId: user.id, role: user.role, tenantId: user.tenantId });
  } catch (error) {
    console.error("Login error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
};

export const GetProfileController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const user = await prisma.customer.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        dateOfBirth: true,
        pan: true,
        role: true,
        tenantId: true,
        customerType: true,
        settingConfig: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json(user);
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const RegisterController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parseResult = registerSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    res.status(400).json({ errors });
    return;
  }

  const {
    name,
    email,
    phone,
    password,
    dateOfBirth,
    pan,
    tenantId,
    settingConfig,
    address,
  } = parseResult.data;

  try {
    const existingUser = await prisma.customer.findUnique({
      where: { email },
    });

    if (existingUser) {
      res.status(409).json({ error: "User with this email already exists" });
      return;
    }

    // Check for duplicate phone
    const existingPhone = await prisma.customer.findUnique({
      where: { phone },
    });

    if (existingPhone) {
      res.status(409).json({ error: "User with this phone number already exists" });
      return;
    }

    // Check for duplicate PAN
    const existingPan = await prisma.customer.findUnique({
      where: { pan },
    });

    if (existingPan) {
      res.status(409).json({ error: "User with this PAN already exists" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.customer.create({
      data: {
        name,
        email,
        phone,
        password: hashedPassword,
        address: address as Prisma.InputJsonValue,
        dateOfBirth: new Date(dateOfBirth),
        pan,
        tenantId,
        settingConfig: settingConfig as Prisma.InputJsonValue,
      },
    });

    const fingerprint = generateClientFingerprint(req);
    createTokenAndCookie(res, result.id, fingerprint);

    await trackEvent("auth.register.success", result.id, tenantId, { device_type: "web" });

    const { password: _, ...userWithoutPassword } = result;
    res.status(201).json(userWithoutPassword);
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const EditUserController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parseResult = editUserSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    res.status(400).json({ errors });
    return;
  }

  const { id, name, email, phone, dateOfBirth, pan, settingConfig, address } =
    parseResult.data;

  try {
    const updatedUser = await prisma.customer.update({
      where: { id },
      data: {
        name,
        email,
        phone,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
        pan,
        settingConfig: (settingConfig ?? undefined) as Prisma.InputJsonValue | undefined,
        address: (address ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    const { password: _, ...userWithoutPassword } = updatedUser;
    res.status(200).json(userWithoutPassword);
  } catch (error) {
    console.error("Error Editing Customer", error);
    res.status(500).json({
      error: "Failed to edit customer",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const EditPasswordController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const parseResult = editPasswordSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    res.status(400).json({ errors });
    return;
  }

  const { id, oldPassword, newPassword } = parseResult.data;

  try {
    const user = await prisma.customer.findUnique({
      where: { id },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const passwordMatch = await bcrypt.compare(oldPassword, user.password);

    if (!passwordMatch) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.customer.update({
      where: { id },
      data: { password: hashedPassword },
    });

    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error Editing password", error);
    res.status(500).json({
      error: "Failed to edit password",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};