import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/admin-auth";
import type { Prisma } from "@prisma/client";

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

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

    if (!/^\d+$/.test(rawUserId)) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const userId = BigInt(rawUserId);

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const userExists = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!userExists) {
        return { notFound: true as const };
      }

      const referralsUnlinked = await tx.user.updateMany({
        where: { referrerId: userId },
        data: { referrerId: null },
      });

      const deletedOrders = await tx.order.deleteMany({
        where: { userId },
      });

      const deletedLogs = await tx.log.deleteMany({
        where: { userId },
      });

      // rawUserId is digits-only, so this interpolation is safe and avoids BigInt bind quirks in SQLite raw params
      await tx.$executeRawUnsafe(`DELETE FROM banned_users WHERE userId = ${rawUserId}`);

      const deletedUsers = await tx.user.deleteMany({
        where: { id: userId },
      });
      if (deletedUsers.count === 0) {
        return { notFound: true as const };
      }

      return {
        notFound: false as const,
        referralsUnlinked: referralsUnlinked.count,
        deletedOrders: deletedOrders.count,
        deletedLogs: deletedLogs.count,
      };
    });

    if (result.notFound) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, result });
  } catch (error) {
    if (hasPrismaCode(error, "P2025")) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (hasPrismaCode(error, "P2003")) {
      return NextResponse.json({ error: "Cannot delete user due to related records" }, { status: 409 });
    }
    console.error("delete-user route failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
