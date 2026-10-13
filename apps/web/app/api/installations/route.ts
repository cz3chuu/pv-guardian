import { NextRequest, NextResponse } from "next/server";
const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8001";
export async function POST(request: NextRequest) {
  try {
    const response = await fetch(`${mlServiceUrl}/installations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text(), cache: "no-store" });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
  } catch (error) { return NextResponse.json({ detail: `Usługa ML jest niedostępna: ${String(error)}` }, { status: 503 }); }
}
