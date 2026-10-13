# Roadmap

- [x] Faza 0 — szkielet repo, docker-compose, schema Postgres
- [x] Faza 1 — ingestion: zapis danych z PVGIS/Open-Meteo do bazy
- [x] Faza 2 — import CSV z produkcją rzeczywistą (upload w Next.js)
- [x] Faza 3 — model bazowy (XGBoost), trening + predykcja przez API
- [x] Faza 4 — anomaly detection: zapis do tabeli `anomalies`, integracja z `/predict`, klasyfikacja przyczyny
- [x] Faza 5 — dashboard: lista instalacji, wykresy, lista alertów
- [x] Tryb symulacji — raport PVGIS dla klienta bez istniejącej instalacji i odczytów
- [x] Analityka modeli — baseline vs XGBoost, metryki godzinowe/dzienne, błędy miesięczne i sezonowe
- [x] Rozszerzone anomalie — zabrudzenie, cień, śnieg, awaria falownika i spadek sprawności
- [x] Kreator lokalizacji — adres, działka ULDK, geolokalizacja i wybór punktu na mapie
- [ ] Faza 6 — deploy na Hetzner/Coolify, case study na jednej realnej instalacji
- [ ] (opcjonalnie) pg-boss do cyklicznego odświeżania danych zamiast ręcznego wywoływania ingest
