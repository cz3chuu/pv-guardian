import { NextResponse } from "next/server";
const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8001";
export async function GET() {
  try { const response = await fetch(`${mlServiceUrl}/automation/status`, { cache: "no-store" }); return NextResponse.json(await response.json(), { status: response.status }); }
  catch (error) { return NextResponse.json({ enabled: false, detail: String(error) }, { status: 503 }); }
}
