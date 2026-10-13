# PV Guardian

Prognozowanie produkcji PV + wykrywanie anomalii (zabrudzenie, cień, awaria falownika).

## Architektura

```
apps/web          -> Next.js (App Router, TS) - dashboard, upload CSV, API do CRUD instalacji
apps/ml-service    -> FastAPI (Python) - ingestion danych pogodowych, trening modelu, predykcja, anomaly detection
packages/db        -> Prisma schema (współdzielony przez web; ml-service łączy się bezpośrednio przez psycopg/SQLAlchemy)
```

Przepływ danych:

```
PVGIS / Open-Meteo / IMGW
        |
        v
apps/ml-service (ingestion)
        |
        v
PostgreSQL (weather_readings, production_readings)
        |
        v
apps/ml-service (model XGBoost -> forecasts, anomalies)
        |
        v
apps/web (dashboard)
```

## Uruchomienie lokalne

1. Skopiuj `.env.example` -> `.env` w katalogu głównym oraz w `apps/web` i `apps/ml-service`.
2. `docker compose up -d postgres` (Postgres wystawiony na hosta pod portem **5433**, nie domyślnym 5432 — żeby nie kolidować z innymi lokalnymi kontenerami Postgresa)
3. `cd packages/db && npx prisma migrate dev`
4. `cd apps/ml-service && pip install -r requirements.txt --break-system-packages && uvicorn app.main:app --reload --port 8000`

## Obsługa bez Swaggera i harmonogramy

Po uruchomieniu Dockera wejdź na `http://localhost:3000/installations`. Z tego miejsca można dodać instalację, a w jej szczegółach kolejno pobrać dane historyczne, odświeżyć pogodę, wytrenować model i wygenerować prognozę.

ML-service automatycznie wykonuje dwa cykle dla wszystkich instalacji:

- codziennie: Open-Meteo → prognoza → wykrywanie anomalii,
- co tydzień: ponowny trening → Open-Meteo → prognoza → wykrywanie anomalii.

Interwały konfiguruje się zmiennymi `AUTOMATION_DAILY_SECONDS` i `AUTOMATION_WEEKLY_SECONDS` w `docker-compose.yml`. Wytrenowane modele są przechowywane w wolumenie `pvguardian_models`, więc nie znikają po przebudowie kontenera.
5. `cd apps/web && npm install && npm run dev`

Albo od razu całość: `docker compose up --build`

## API ml-service

- `POST /installations` — tworzy instalację
- `GET /installations` — lista instalacji
- `POST /ingest/open-meteo-history/{installation_id}` — pogoda historyczna Open-Meteo (Historical Forecast API od 2022 r., ERA5 wcześniej) z promieniowaniem na płaszczyźnie paneli; bez parametrów pobiera tylko okres wgranej produkcji, który nie ma jeszcze pogody (opcjonalnie `start_date`, `end_date`)
- `POST /ingest/open-meteo/{installation_id}` — prognoza Open-Meteo (`forecast_days` ≤ 16) + ostatnie `past_days` dni (domyślnie 7) zapisywane jako pogoda historyczna
- `POST /ingest/pvgis/{installation_id}` — dane PVGIS 2005–2020 (do symulacji; nie są używane w treningu)
- `POST /forecast` — baseline prognozy z PVGIS (bez zapisu do bazy)
- `POST /train/{installation_id}` — trening (patrz „Model”), zapisuje model + analizę błędów do `trained_models/{id}.xgboost-v3.joblib`; w odpowiedzi `mae_kwh`, `predictor`, `excluded_outliers`, `time_alignment`
- `GET /predict/{installation_id}` — prognoza na podstawie prognozy Open-Meteo, domyślnie zapisuje do `forecasts` i uruchamia wykrywanie anomalii (`detect_anomalies=true`)
- `GET /installations/{installation_id}/model-analysis` — analiza błędów z treningu (holdout), baseline vs XGBoost
- `GET /anomalies/check?predicted_kwh=&actual_kwh=` — szybki test progu anomalii dla pojedynczego punktu (bez zapisu, bez klasyfikacji przyczyny)
- `GET /installations/{installation_id}/anomalies` — lista zapisanych anomalii dla instalacji

Uwaga: ml-service łączy się z tymi samymi tabelami co Prisma, ale nie zarządza migracjami — schemat trzeba najpierw założyć przez `npm run db:migrate`.

## Konwencja czasu

- **Wszystkie znaczniki czasu w bazie są w UTC** i oznaczają **początek godziny** (10:00 = energia z 10:00–11:00).
- Open-Meteo jest pobierane z `timezone=UTC`; promieniowanie (średnia z poprzedzającej godziny) jest przesuwane do konwencji „początek godziny”.
- PVGIS zwraca czas `HH:10` UTC — wyrównujemy go do pełnej godziny.
- CSV: znaczniki bez strefy są traktowane jako czas wybrany w formularzu (domyślnie `Europe/Warsaw`, z obsługą zmiany czasu) i zamieniane na UTC.

## Model

Model „fizyczny + korekta”: model fizyczny liczy energię oczekiwaną z promieniowania na płaszczyźnie paneli (`global_tilted_irradiance` z Open-Meteo dla kąta i azymutu instalacji), mocy, strat i temperatury ogniw; XGBoost uczy się współczynnika korekty (rzeczywista / oczekiwana) zależnego od położenia słońca, zachmurzenia itp. — wyłapuje stałe zacienienie, odbicia i błędy modelu pogody, a jednocześnie poprawnie ekstrapoluje na inne pory roku.

- trening i predykcja używają tych samych zmiennych z tego samego źródła (Open-Meteo),
- z treningu odrzucane są godziny wyglądające na awarię/błąd danych oraz dni z wykrytymi anomaliami,
- ewaluacja: końcowe 20% każdego miesiąca; jeśli XGBoost nie pobija skalibrowanego modelu fizycznego (albo danych jest < 300 godzin dziennych), prognozy używają modelu fizycznego (`predictor: "baseline"`),
- `time_alignment` sprawdza korelację produkcji z pogodą przy przesunięciach −3…+3 h i ostrzega, gdy dane CSV są przesunięte (zła strefa czasowa, znacznik końca godziny).

Anomalie: dzienna produkcja jest porównywana z produkcją **oczekiwaną przy rzeczywistej pogodzie** (pogoda historyczna), a nie z prognozą sprzed kilku dni — błąd prognozy pogody nie generuje fałszywych alarmów. Dni z okresu treningowego są oceniane skalibrowanym modelem fizycznym (bez wycieku danych), późniejsze — wybranym modelem. Pomijane są dni z < 80% godzin z odczytem oraz bardzo ciemne dni (chyba że produkcja jest zerowa).

## API web (Next.js)

- `POST /api/installations/{id}/production` — upload CSV (multipart: `file`, opcjonalnie `timezone`, `replace=true`) z kolumnami `timestamp` i `energy_kwh`; separator `,`/`;`/tab, przecinek dziesiętny, formaty `2025-06-01 10:00`, `2025-06-01T10:00:00Z`, `01.06.2025 10:00`; dane 5/15-minutowe są sumowane do godzin
- `/installations/{id}` — strona instalacji z formularzem uploadu

## Typowy przebieg end-to-end

1. Dodaj instalację (lat/lon/moc/kąt/azymut) w `/installations`
2. Wgraj CSV z produkcją (eksport z portalu falownika) na stronie instalacji
3. **Pobierz dane historyczne** — pogoda Open-Meteo dla okresu produkcji
4. **Wytrenuj model** — sprawdź `mae_kwh`, `predictor` i ewentualne ostrzeżenie `time_alignment`
5. **Odśwież pogodę** i **Wygeneruj prognozę** — prognoza zapisuje się do `forecasts`, anomalie do `anomalies`
6. Dalej działa automatyzacja: codziennie prognoza + pogoda z ostatnich 7 dni + anomalie, co tydzień dociągnięcie historii i ponowny trening

### Aktualizacja istniejącej bazy (październik 2026)

Po aktualizacji uruchom migrację (`npm run db:migrate`) i jednorazowo `packages/db/scripts/cleanup-before-utc-fix.sql` (opis w pliku) — usuwa prognozy pogody, prognozy produkcji i anomalie zapisane ze złym przesunięciem czasu. Stare modele (`xgboost-v2`) nie są już wczytywane — trzeba wytrenować model ponownie.

## Źródła danych i obliczenia

| Dane | Źródło | Gdzie |
|---|---|---|
| Produkcja PV dla lokalizacji (symulacja, projektant) | PVGIS 5.3 (SARAH3), lata 2019–2023, profil godzinowy „typowego roku” przeskalowany do średnich miesięcznych | `POST /simulate` (ml-service, cache w pamięci) |
| Pogoda: historia i prognoza dla instalacji | Open-Meteo (Historical Forecast / ERA5 / Forecast), promieniowanie na płaszczyźnie paneli | ml-service |
| Ceny RCE (sprzedaż nadwyżek, net-billing) | PSE `rce-pln`, ostatnie 12 miesięcy → średnia [miesiąc × godzina], ujemne ceny = 0 | `/api/energy-prices/yearly` |
| Ceny RCE dziś | PSE `rce-pln` | `/api/energy-prices` |
| Generacja PV w Polsce (rzeczywista i prognoza) | PSE `his-wlk-cal` i `pk5l-wp` | `/api/regional-live` |
| Uzysk w województwach | Open-Meteo dla siatki ~120 punktów w granicach województw (GUGiK PRG), panele 35° na południe, PR 0,86 z poprawką temperaturową | `/api/regional-live` (cache 1 h) |
| Adresy | GUGiK UUG (punkty adresowe), fallback Nominatim | `/api/location/address` |
| Obrys budynku | OpenStreetMap (Overpass) | `/api/location/building` |
| Działki | GUGiK ULDK | `/api/location/parcel` |

Kalkulator finansowy w projektancie i symulacji liczy **bilans godzina po godzinie** (`apps/web/lib/energy-balance.ts`): produkcja z PVGIS (dla każdej połaci osobno, pomniejszona o cień) vs profil zużycia (dobowy kształt × sezonowość), magazyn energii (sprawność 92%, moc 0,5C), nadwyżki wyceniane po RCE. Straty od cienia (`apps/web/lib/solar.ts`) liczone są z położenia słońca dla każdej godziny i udziału promieniowania bezpośredniego z PVGIS.

## Status

Fazy 0–5 zaimplementowane — patrz `ROADMAP.md`.
