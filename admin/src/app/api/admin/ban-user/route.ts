import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/admin-auth";

async function ensureBannedUsersTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS banned_users (
      userId INTEGER PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT ''
    )
  `);
}

export async function POST(req: Request) {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  try {
    await ensureBannedUsersTable();
    const payload = await req.json();
    const rawUserId = String(payload?.userId ?? "").trim();
    const ban = Boolean(payload?.ban);
    const reason = String(payload?.reason ?? "").trim().slice(0, 300);

    if (!/^\d+$/.test(rawUserId)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const userId = BigInt(rawUserId);
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!userExists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (ban) {
      await prisma.$executeRaw`
        INSERT INTO banned_users (userId, createdAt, reason)
        VALUES (${userId}, ${new Date().toISOString()}, ${reason})
        ON CONFLICT(userId) DO UPDATE SET reason = excluded.reason
      `;
      await prisma.$executeRaw`
        INSERT INTO logs (userId, action, details, createdAt)
        VALUES (${userId}, ${"admin_ban_user"}, ${reason || "Banned via admin panel"}, ${new Date().toISOString()})
      `;
    } else {
      await prisma.$executeRaw`DELETE FROM banned_users WHERE userId = ${userId}`;
      await prisma.$executeRaw`
        INSERT INTO logs (userId, action, details, createdAt)
        VALUES (${userId}, ${"admin_unban_user"}, ${"Unbanned via admin panel"}, ${new Date().toISOString()})
      `;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("ban-user route failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
