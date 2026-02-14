import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/server-env";
import { requireAdminAuth } from "@/lib/admin-auth";
import { enqueueBroadcastJob, getBroadcastJob } from "@/lib/broadcast-jobs";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_REQUEST_TIMEOUT_MS = 15000;
const BROADCAST_BATCH_SIZE = 10;
const BROADCAST_BATCH_DELAY_MS = 500;
const MAX_BROADCAST_RECIPIENTS = 5000;
type Segment =
  | "all"
  | "no_paid_24h"
  | "inactive_3d"
  | "inactive_7d"
  | "one_paid_no_repeat_7d"
  | "paid_no_referrals";

function toEpochMsExpr(columnRef: string): string {
  return `
    CASE
      WHEN typeof(${columnRef}) = 'integer' THEN CAST(${columnRef} AS INTEGER)
      WHEN trim(CAST(${columnRef} AS TEXT)) GLOB '[0-9]*' THEN CAST(${columnRef} AS INTEGER)
      ELSE CAST(strftime('%s', ${columnRef}) AS INTEGER) * 1000
    END
  `;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessage(token: string, chatId: string, text: string) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload?.ok, payload };
}

async function sendPhoto(token: string, chatId: string, photoFile: File, caption: string) {
  const body = new FormData();
  body.set("chat_id", chatId);
  if (caption) {
    body.set("caption", caption.slice(0, 1024));
    body.set("parse_mode", "HTML");
  }
  body.set("photo", photoFile, photoFile.name || "broadcast.jpg");

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendPhoto`, {
    method: "POST",
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    body,
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload?.ok, payload };
}

async function runBroadcastSend(args: {
  recipients: Array<{ id: bigint }>;
  token: string;
  hasPhoto: boolean;
  photo: File | null;
  text: string;
}): Promise<{ sent: number; failed: number; failedUsers: string[] }> {
  let success = 0;
  let failed = 0;
  const failedUsers: string[] = [];

  for (let offset = 0; offset < args.recipients.length; offset += BROADCAST_BATCH_SIZE) {
    const batch = args.recipients.slice(offset, offset + BROADCAST_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (user) => {
        const chatId = user.id.toString();
        try {
          const result = args.hasPhoto
            ? await sendPhoto(args.token, chatId, args.photo as File, args.text)
            : await sendMessage(args.token, chatId, args.text.slice(0, 4096));

          if (result.ok) {
            return { ok: true as const, chatId };
          }

          return {
            ok: false as const,
            chatId,
            error: String(result.payload?.description ?? "send failed"),
          };
        } catch (error) {
          return {
            ok: false as const,
            chatId,
            error: error instanceof Error ? error.message : "unknown error",
          };
        }
      }),
    );

    for (const item of results) {
      if (item.ok) {
        success += 1;
      } else {
        failed += 1;
        if (failedUsers.length < 25) {
          failedUsers.push(`${item.chatId}: ${item.error}`);
        }
      }
    }

    if (offset + BROADCAST_BATCH_SIZE < args.recipients.length) {
      await sleep(BROADCAST_BATCH_DELAY_MS);
    }
  }

  return { sent: success, failed, failedUsers };
}

export async function GET(req: Request) {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = getBroadcastJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, job });
}

export async function POST(req: Request) {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  try {
    await ensureBannedUsersTable();
    const token = getServerEnv("BOT_TOKEN");
    if (!token) {
      return NextResponse.json({ error: "BOT_TOKEN is missing" }, { status: 500 });
    }

    const formData = await req.formData();
    const text = String(formData.get("text") ?? "").trim();
    const photo = formData.get("photo");
    const mode = String(formData.get("mode") ?? "broadcast").trim().toLowerCase();
    const previewOnly = mode === "preview";
    const segment = String(formData.get("segment") ?? "all").trim().toLowerCase() as Segment;

    const hasPhoto = photo instanceof File && photo.size > 0;
    if (!text && !hasPhoto) {
      return NextResponse.json({ error: "Text or photo is required" }, { status: 400 });
    }

    const recipients: Array<{ id: bigint }> = [];
    if (previewOnly) {
      const adminTelegramIdRaw = getServerEnv("ADMIN_TELEGRAM_ID");
      if (!adminTelegramIdRaw || !/^\d+$/.test(adminTelegramIdRaw)) {
        return NextResponse.json(
          { error: "ADMIN_TELEGRAM_ID is missing or invalid" },
          { status: 500 },
        );
      }
      recipients.push({ id: BigInt(adminTelegramIdRaw) });
    } else {
      const nowMs = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const inactive3dThreshold = nowMs - 3 * dayMs;
      const inactive7dThreshold = nowMs - 7 * dayMs;
      const noPaid24hThreshold = nowMs - dayMs;
      const userCreatedAtMs = toEpochMsExpr("u.createdAt");
      const logCreatedAtMs = toEpochMsExpr("createdAt");
      const orderCreatedAtMs = toEpochMsExpr("createdAt");

      let users: Array<{ id: bigint }> = [];
      if (segment === "no_paid_24h") {
        users = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          WHERE bu.userId IS NULL
            AND ${userCreatedAtMs} <= ${noPaid24hThreshold}
            AND NOT EXISTS (
              SELECT 1 FROM orders o WHERE o.userId = u.id AND o.status LIKE 'paid%'
            )
          ORDER BY u.rowid ASC
        `);
      } else if (segment === "inactive_3d") {
        users = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          LEFT JOIN (
            SELECT userId, MAX(${logCreatedAtMs}) AS lastActivity
            FROM logs
            GROUP BY userId
          ) l ON l.userId = u.id
          WHERE bu.userId IS NULL
            AND COALESCE(l.lastActivity, ${userCreatedAtMs}) <= ${inactive3dThreshold}
          ORDER BY u.rowid ASC
        `);
      } else if (segment === "inactive_7d") {
        users = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          LEFT JOIN (
            SELECT userId, MAX(${logCreatedAtMs}) AS lastActivity
            FROM logs
            GROUP BY userId
          ) l ON l.userId = u.id
          WHERE bu.userId IS NULL
            AND COALESCE(l.lastActivity, ${userCreatedAtMs}) <= ${inactive7dThreshold}
          ORDER BY u.rowid ASC
        `);
      } else if (segment === "one_paid_no_repeat_7d") {
        users = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          JOIN (
            SELECT userId, COUNT(1) AS paidCount, MAX(${orderCreatedAtMs}) AS lastPaidAt
            FROM orders
            WHERE status LIKE 'paid%'
            GROUP BY userId
          ) p ON p.userId = u.id
          WHERE bu.userId IS NULL
            AND p.paidCount = 1
            AND p.lastPaidAt <= ${inactive7dThreshold}
          ORDER BY u.rowid ASC
        `);
      } else if (segment === "paid_no_referrals") {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          WHERE bu.userId IS NULL
            AND EXISTS (SELECT 1 FROM orders o WHERE o.userId = u.id AND o.status LIKE 'paid%')
            AND NOT EXISTS (SELECT 1 FROM users r WHERE r.referrerId = u.id)
          ORDER BY u.rowid ASC
        `;
      } else {
        users = await prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT u.id
          FROM users u
          LEFT JOIN banned_users bu ON bu.userId = u.id
          WHERE bu.userId IS NULL
          ORDER BY u.rowid ASC
        `;
      }
      recipients.push(...users);
    }

    if (!previewOnly && recipients.length > MAX_BROADCAST_RECIPIENTS) {
      return NextResponse.json(
        {
          error: `Broadcast audience too large (${recipients.length}). Use tighter segment or increase MAX_BROADCAST_RECIPIENTS.`,
        },
        { status: 400 },
      );
    }

    if (!previewOnly) {
      const job = enqueueBroadcastJob({
        mode: "broadcast",
        segment,
        total: recipients.length,
        worker: async () =>
          runBroadcastSend({
            recipients,
            token,
            hasPhoto,
            photo: photo as File | null,
            text,
          }),
      });

      return NextResponse.json(
        {
          success: true,
          mode: "broadcast",
          segment,
          queued: true,
          jobId: job.id,
          total: recipients.length,
        },
        { status: 202 },
      );
    }

    const result = await runBroadcastSend({
      recipients,
      token,
      hasPhoto,
      photo: photo as File | null,
      text,
    });

    return NextResponse.json({
      success: true,
      mode: "preview",
      segment,
      total: recipients.length,
      sent: result.sent,
      failed: result.failed,
      failedUsers: result.failedUsers,
    });
  } catch (error) {
    console.error("Broadcast failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
