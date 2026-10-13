import { NextResponse } from "next/server";
const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8001";
const allowedActions = new Set(["history", "weather", "train", "predict", "refresh", "analysis"]);
export async function POST(_: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (!allowedActions.has(action)) return NextResponse.json({ detail: "Nieznana operacja" }, { status: 400 });
  try {
    const response = await fetch(`${mlServiceUrl}/installations/${encodeURIComponent(id)}/actions/${action}`, { method: "POST", cache: "no-store" });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
  } catch (error) { return NextResponse.json({ detail: `Usługa ML jest niedostępna: ${String(error)}` }, { status: 503 }); }
}
