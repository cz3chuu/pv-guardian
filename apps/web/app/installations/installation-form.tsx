"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
export function InstallationForm() {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null); const form = new FormData(event.currentTarget);
    const payload = { name: form.get("name"), latitude: Number(form.get("latitude")), longitude: Number(form.get("longitude")), peak_power_kwp: Number(form.get("power")), tilt_angle: Number(form.get("tilt")), azimuth: Number(form.get("azimuth")), losses: 14 };
    try { const response = await fetch("/api/installations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const data = await response.json(); if (!response.ok) throw new Error(data.detail ?? "Nie udało się dodać instalacji"); event.currentTarget.reset(); setMessage("Instalacja została dodana."); router.refresh(); }
    catch (error) { setMessage(`Błąd: ${error instanceof Error ? error.message : String(error)}`); } finally { setBusy(false); }
  }
  return <form className="installation-form" onSubmit={submit}><label>Nazwa<input name="name" required placeholder="Dom — dach południowy"/></label><label>Szerokość geogr.<input name="latitude" required type="number" step="any" placeholder="52.2297"/></label><label>Długość geogr.<input name="longitude" required type="number" step="any" placeholder="21.0122"/></label><label>Moc instalacji (kWp)<input name="power" required type="number" min="0.1" step="0.1" placeholder="5.0"/></label><label>Nachylenie paneli (°)<input name="tilt" required type="number" min="0" max="90" defaultValue="30"/></label><label>Azymut (°)<input name="azimuth" required type="number" min="-180" max="180" defaultValue="0"/></label><button className="button" disabled={busy}>{busy ? "Dodawanie…" : "Dodaj instalację"}</button>{message && <p className="form-message">{message}</p>}</form>;
}
