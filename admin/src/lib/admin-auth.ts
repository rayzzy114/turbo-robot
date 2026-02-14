import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/server-env";

const REALM = 'Basic realm="Admin Panel"';

function challenge(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": REALM },
  });
}

function parseBasicAuth(authHeader: string | null): { user: string; pass: string } | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) return null;
  try {
    const encoded = authHeader.slice(6).trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return {
      user: decoded.slice(0, sep),
      pass: decoded.slice(sep + 1),
    };
  } catch {
    return null;
  }
}

export function requireAdminAuth(request: Request): NextResponse | null {
  const adminUser = getServerEnv("ADMIN_USER");
  const adminPass = getServerEnv("ADMIN_PASS");

  if (!adminUser || !adminPass) {
    return NextResponse.json(
      { error: "ADMIN_USER and ADMIN_PASS must be configured" },
      { status: 500 },
    );
  }

  const creds = parseBasicAuth(request.headers.get("authorization"));
  if (!creds || creds.user !== adminUser || creds.pass !== adminPass) {
    return challenge();
  }

  return null;
}
