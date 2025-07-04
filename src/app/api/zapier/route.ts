import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const data = await req.json();

  const zapierWebhookURL = "https://hooks.zapier.com/hooks/catch/xxxxxxx/yyyyyyy";

  const res = await fetch(zapierWebhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (res.ok) {
    return NextResponse.json({ status: "success" });
  } else {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
