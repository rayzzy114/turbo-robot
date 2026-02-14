import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $executeRawUnsafe: vi.fn(),
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  $transaction: vi.fn(),
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

import { POST as addBalancePOST } from "../admin/src/app/api/admin/add-balance/route";
import { POST as banUserPOST } from "../admin/src/app/api/admin/ban-user/route";
import { POST as broadcastPOST } from "../admin/src/app/api/admin/broadcast/route";
import { GET as categoryDiscountsGET, POST as categoryDiscountsPOST } from "../admin/src/app/api/admin/category-discounts/route";
import { POST as deleteUserPOST } from "../admin/src/app/api/admin/delete-user/route";
import { POST as resetStatsPOST } from "../admin/src/app/api/admin/reset-stats/route";

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

describe("admin API auth guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_USER = "admin";
    process.env.ADMIN_PASS = "secret";
  });

  const cases: Array<[string, (req: Request) => Promise<Response>, "GET" | "POST"]> = [
    ["add-balance", addBalancePOST, "POST"],
    ["ban-user", banUserPOST, "POST"],
    ["broadcast", broadcastPOST, "POST"],
    ["category-discounts-post", categoryDiscountsPOST, "POST"],
    ["category-discounts-get", categoryDiscountsGET, "GET"],
    ["delete-user", deleteUserPOST, "POST"],
    ["reset-stats", resetStatsPOST, "POST"],
  ];

  it.each(cases)("rejects unauthenticated requests: %s", async (_, handler, method) => {
    const request = new Request(`http://localhost/api/admin/${method.toLowerCase()}`, {
      method,
    });
    const response = await handler(request);
    expect(response.status).toBe(401);
  });

  it("allows authenticated add-balance request to reach validation layer", async () => {
    const request = new Request("http://localhost/api/admin/add-balance", {
      method: "POST",
      headers: {
        authorization: basicAuth("admin", "secret"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: "abc", amount: 10, operation: "add" }),
    });
    const response = await addBalancePOST(request);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toContain("Invalid userId");
  });
});
