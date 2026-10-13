"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const TIME_ZONES = [
  { value: "Europe/Warsaw", label: "Czas polski (Europe/Warsaw, z letnim/zimowym)" },
  { value: "UTC", label: "UTC" },
];

export function UploadProductionForm({ installationId }: { installationId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) {
      setStatus("Wybierz plik CSV.");
      return;
    }

    setBusy(true);
    setStatus(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("timezone", (form.elements.namedItem("timezone") as HTMLSelectElement).value);
    formData.append("replace", String((form.elements.namedItem("replace") as HTMLInputElement).checked));

    try {
      const res = await fetch(`/api/installations/${installationId}/production`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus(`Błąd: ${data.error ?? "nieznany błąd"}`);
      } else {
        const errCount = data.parseErrors?.length ?? 0;
        setStatus(
          `Wgrano ${data.inserted} z ${data.totalRows} godzin (pominięto ${data.skipped} istniejących` +
            (data.replaced ? `, zastąpiono ${data.replaced}` : "") +
            `).` +
            (data.aggregatedFrom ? ` Zsumowano ${data.aggregatedFrom} odczytów do pełnych godzin.` : "") +
            (errCount ? ` Błędy parsowania: ${errCount} (pierwszy: ${data.parseErrors[0]}).` : "") +
            " Teraz pobierz dane historyczne pogody i wytrenuj model."
        );
        router.refresh();
      }
    } catch (err) {
      setStatus(`Błąd połączenia: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input type="file" name="file" accept=".csv,.txt" />
      <label>
        Strefa czasowa znaczników bez strefy
        <select name="timezone" defaultValue="Europe/Warsaw">
          {TIME_ZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" name="replace" /> Nadpisz istniejące odczyty z zakresu pliku
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Wgrywanie..." : "Wgraj CSV"}
      </button>
      {status && <p>{status}</p>}
    </form>
  );
}
