import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import CredentialsProvider from "next-auth/providers/credentials"
import { getUserRole, getAdminApps } from "@/lib/rbac-server"

import { NextAuthOptions } from 'next-auth';

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),
    CredentialsProvider({
      name: "Development Login",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "admin@example.com" }
      },
      async authorize(credentials) {
        if (!credentials?.email) return null;
        
        // Return a mock user object with the provided email
        return {
          id: credentials.email,
          email: credentials.email,
          name: credentials.email.split('@')[0]
        };
      }
    })
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt" },
  cookies: {
    sessionToken: {
      name: 'analytics-dash.session-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false },
    },
    callbackUrl: {
      name: 'analytics-dash.callback-url',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false },
    },
    csrfToken: {
      name: 'analytics-dash.csrf-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      // Incoming user is defined only on initial sign in
      if (user) {
        token.role = getUserRole(user.email);
        token.adminApps = getAdminApps(user.email);
      }

      // Keep RBAC in sync on subsequent requests as well.
      if (token.email) {
        token.role = getUserRole(token.email);
        token.adminApps = getAdminApps(token.email);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = token.role || 'user';
        session.user.adminApps = token.adminApps || [];
      }
      return session;
    }
  },
  pages: {
    signIn: '/login',
    error: '/unauthorized',
  }
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
