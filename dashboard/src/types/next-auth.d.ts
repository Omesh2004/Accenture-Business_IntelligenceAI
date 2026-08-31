import NextAuth, { DefaultSession, DefaultUser } from "next-auth"
import { JWT } from "next-auth/jwt"
import { UserRole } from "@/lib/rbac"

declare module "next-auth" {
  interface Session {
    user: {
      role: UserRole;
      adminApps: string[];
    } & DefaultSession["user"]
  }

  interface User extends DefaultUser {
    role?: UserRole;
    adminApps?: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: UserRole;
    adminApps?: string[];
  }
}
