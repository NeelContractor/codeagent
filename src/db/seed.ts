import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { client, db } from "@/db/client";
import { users } from "@/db/schema";

const email = process.env.SEED_EMAIL ?? "dev@codeagent.test";
const password = process.env.SEED_PASSWORD ?? "devpassword";
const name = process.env.SEED_NAME ?? "Dev User";

const passwordHash = await hash(password, 10);
const existing = await db.query.users.findFirst({
  where: eq(users.email, email),
});

if (existing) {
  await db
    .update(users)
    .set({ passwordHash, name })
    .where(eq(users.id, existing.id));
  console.log(`Updated existing user ${email}`);
} else {
  await db.insert(users).values({ email, name, passwordHash });
  console.log(`Created user ${email}`);
}

console.log(`Sign in at /login with ${email} / ${password}`);
await client.end();
