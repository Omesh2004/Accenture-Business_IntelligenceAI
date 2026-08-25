import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { trackEvent } from "./eventTracker";

interface DecodedToken {
  userId: string;
  fingerprint: string;
  iat?: number;
  exp?: number;
}

export interface RequestWithUser extends Request {
  user?: { id: string; role: string; tenantId: string; pan: string; email: string };
}

/**
 * Middleware: verifies admin role (must come after isLoggedIn).
 */
export const isAdmin = async (
  req: RequestWithUser,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (req.user?.role !== "ADMIN") {
    trackEvent("auth.role.violation", req.user?.id || null, req.user?.tenantId || "bank_a", {
      role: req.user?.role || "anonymous",
      attempted_action: `${req.method} ${req.originalUrl}`,
      path: req.originalUrl,
    }).catch(() => {});
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
};

function generateFingerprint(req: Request): string {
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

async function rotateSession(
  res: Response,
  userId: string,
  fingerprint: string
): Promise<void> {
  const jwtSecret = process.env.JWT_SEC;
  if (!jwtSecret) {
    throw new Error("JWT_SEC is not defined in environment variables");
  }

  const newToken = jwt.sign({ userId, fingerprint }, jwtSecret, {
    expiresIn: "12h",
  });

  res.cookie("token", newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 12 * 60 * 60 * 1000,
  });
}

export const isLoggedIn = async (
  req: RequestWithUser,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.cookies?.token as string | undefined;

    if (!token) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const jwtSecret = process.env.JWT_SEC;
    if (!jwtSecret) {
      throw new Error("JWT_SEC is not defined in environment variables");
    }

    const decoded = jwt.verify(token, jwtSecret) as DecodedToken;
    const currentFingerprint = generateFingerprint(req);

    if (decoded.fingerprint !== currentFingerprint) {
      res.status(401).json({ message: "Invalid session" });
      return;
    }

    const tokenExpiryTime = decoded.exp ? decoded.exp - Date.now() / 1000 : 0;

    // Rotate only if the token is close to expiration (within 30 minutes)
    if (tokenExpiryTime < 1800) {
      await rotateSession(res, decoded.userId, currentFingerprint);
    }

    const user = await prisma.customer.findUnique({
      where: { id: decoded.userId },
      select: { role: true, tenantId: true, pan: true, email: true },
    });

    if (!user) {
      res.status(401).json({ message: "Session invalid: User not found" });
      return;
    }

    req.user = { 
      id: decoded.userId, 
      role: user.role, 
      tenantId: user.tenantId || "bank_a", 
      pan: user.pan || "",
      email: user.email,
    };
    next();
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ message: "Session expired, please login again" });
    } else if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: "Invalid session token" });
    } else {
      const errorMessage = error instanceof Error ? error.message : "Authentication error";
      res.status(500).json({ message: errorMessage });
    }
    return;
  }
};

export const CookieSend = async (
  req: RequestWithUser,
  res: Response
): Promise<void> => {
  try {
    const token = req.cookies?.token as string | undefined;

    if (!token) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const jwtSecret = process.env.JWT_SEC;
    if (!jwtSecret) {
      throw new Error("JWT_SEC is not defined in environment variables");
    }

    const decoded = jwt.verify(token, jwtSecret) as DecodedToken;
    const currentFingerprint = generateFingerprint(req);

    if (decoded.fingerprint !== currentFingerprint) {
      res.status(401).json({ message: "Invalid session" });
      return;
    }

    const tokenExpiryTime = decoded.exp ? decoded.exp - Date.now() / 1000 : 0;

    // Rotate only if the token is close to expiration (within 30 minutes)
    if (tokenExpiryTime < 1800) {
      await rotateSession(res, decoded.userId, currentFingerprint);
    }

    const user = await prisma.customer.findUnique({
      where: { id: decoded.userId },
      select: { role: true, tenantId: true, pan: true, email: true },
    });

    if (!user) {
      res.status(401).json({ message: "Session invalid: User not found" });
      return;
    }

    req.user = { 
      id: decoded.userId, 
      role: user.role, 
      tenantId: user.tenantId || "bank_a", 
      pan: user.pan || "",
      email: user.email,
    };
    res.status(200).json(req.user);
  } catch (error: unknown) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ message: "Session expired, please login again" });
    } else if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: "Invalid session token" });
    } else {
      const errorMessage = error instanceof Error ? error.message : "Authentication error";
      res.status(500).json({ message: errorMessage });
    }
    return;
  }
};
