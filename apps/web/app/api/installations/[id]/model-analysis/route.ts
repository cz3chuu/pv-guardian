import { NextResponse } from "next/server";
const mlServiceUrl = process.env.ML_SERVICE_URL ?? "http://localhost:8001";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const response = await fetch(`${mlServiceUrl}/installations/${encodeURIComponent(id)}/model-analysis`, { cache: "no-store" });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json" } });
  } catch (error) { return NextResponse.json({ detail: `Analiza ML jest niedostępna: ${String(error)}` }, { status: 503 }); }
}
