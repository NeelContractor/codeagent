import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { db } from "@/db/client";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";

export const githubEnabled = Boolean(
  process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET,
);

export const credentialsEnabled =
  process.env.AUTH_ENABLE_CREDENTIALS === "true";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    ...(githubEnabled
      ? [
          GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
            // `public_repo` is the narrowest scope that still allows cloning
            // and pushing. It deliberately does not grant access to private
            // repositories. Users who signed in before this scope existed must
            // re-authorize before push will work.
            authorization: {
              scope: "read:user user:email public_repo",
              params: { allow_signup: "true" },
            },
          }),
        ]
      : []),
    ...(credentialsEnabled
      ? [
          Credentials({
            name: "Email",
            credentials: {
              email: { label: "Email", type: "email" },
              password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
              const email =
                typeof credentials?.email === "string"
                  ? credentials.email.toLowerCase()
                  : "";
              const password =
                typeof credentials?.password === "string"
                  ? credentials.password
                  : "";

              if (!email || !password) {
                return null;
              }

              const user = await db.query.users.findFirst({
                where: eq(users.email, email),
              });

              if (!user?.passwordHash) {
                return null;
              }

              const valid = await compare(password, user.passwordHash);

              if (!valid) {
                return null;
              }

              return {
                id: user.id,
                email: user.email,
                name: user.name,
                image: user.image,
              };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    jwt({ token, account, profile }) {
      // Capture the GitHub token on sign-in. The JWT session strategy has no
      // database row to read it back from later.
      if (account?.provider === "github") {
        const accessToken = account.access_token;
        token.githubAccessToken =
          typeof accessToken === "string" ? accessToken : undefined;
        token.githubLogin =
          typeof profile?.login === "string" ? profile.login : undefined;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      if (token.githubAccessToken) {
        session.user.githubAccessToken = token.githubAccessToken;
        session.user.githubLogin = token.githubLogin;
      }
      return session;
    },
    authorized({ auth: session, request: { nextUrl } }) {
      const { pathname } = nextUrl;
      const isLoggedIn = Boolean(session?.user);

      if (pathname.startsWith("/dashboard") && !isLoggedIn) {
        return false;
      }

      if (pathname === "/login" && isLoggedIn) {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }

      return true;
    },
  },
});
