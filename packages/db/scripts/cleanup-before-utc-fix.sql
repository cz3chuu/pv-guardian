-- Jednorazowe sprzatanie danych zapisanych PRZED poprawka stref czasowych (pazdziernik 2026).
--
-- Stara prognoza Open-Meteo byla zapisywana w czasie lokalnym (zamiast UTC), a prognozy
-- i anomalie byly z niej liczone -- sa przesuniete o 1-2 h i nie da sie ich poprawic.
-- Wszystko ponizej mozna odtworzyc przyciskami w panelu instalacji
-- (Pobierz dane historyczne -> Wytrenuj model -> Odswiez pogode -> Wygeneruj prognoze).
--
-- Uruchomienie (Postgres z docker-compose):
--   docker compose exec -T postgres psql -U pvguardian -d pvguardian < packages/db/scripts/cleanup-before-utc-fix.sql

BEGIN;
DELETE FROM weather_readings WHERE source = 'open-meteo';
DELETE FROM forecasts;
DELETE FROM anomalies;
COMMIT;

-- Produkcja (production_readings) NIE jest usuwana. Jesli CSV byl wgrywany przez aplikacje
-- dzialajaca w Dockerze, czas lokalny z pliku zostal zapisany jako UTC (przesuniecie 1-2 h).
-- Wgraj wtedy ten sam plik ponownie z zaznaczonym "Nadpisz istniejace odczyty z zakresu pliku".
-- Trening ostrzeze o przesunieciu (pole time_alignment.warning), jesli dane nadal sa niezgrane.
