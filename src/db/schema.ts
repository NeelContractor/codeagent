import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const messageRoleEnum = pgEnum("message_role", [
  "system",
  "user",
  "assistant",
  "tool",
]);

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  name: text("name"),
  image: text("image"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("projects_user_id_idx").on(table.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    projectId: serial("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls").$type<ToolCall[]>(),
    toolCallId: text("tool_call_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("messages_project_id_created_at_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const fileSnapshots = pgTable(
  "file_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: serial("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    bytes: integer("bytes"),
    fileCount: integer("file_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("file_snapshots_project_id_idx").on(table.projectId)],
);

/**
 * Which GitHub repository a project is bound to.
 *
 * The `.git` directory is excluded from workspace snapshots, so this row is
 * what lets a restored project be re-attached to its remote.
 */
export const gitConnections = pgTable(
  "git_connections",
  {
    projectId: serial("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** GitHub "owner/repo". */
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    remoteUrl: text("remote_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("git_connections_repo_idx").on(table.repo)],
);

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  messages: many(messages),
  fileSnapshots: many(fileSnapshots),
  gitConnection: one(gitConnections),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  project: one(projects, {
    fields: [messages.projectId],
    references: [projects.id],
  }),
}));

export const gitConnectionsRelations = relations(gitConnections, ({ one }) => ({
  project: one(projects, {
    fields: [gitConnections.projectId],
    references: [projects.id],
  }),
}));

export const fileSnapshotsRelations = relations(fileSnapshots, ({ one }) => ({
  project: one(projects, {
    fields: [fileSnapshots.projectId],
    references: [projects.id],
  }),
}));
