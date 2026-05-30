// Phase 5 (morning briefing): today's high/low + conditions from Open-Meteo.
// Free, no API key, no signup. Fully graceful: any failure returns null and the
// briefing simply omits the weather line (never throws, never blocks the send).

// Default to Buffalo metro (public, city-level). Override via env for precise
// local coordinates in .env.local (kept out of this public repo).
const LAT = Number(process.env.CHIEF_WEATHER_LAT ?? 42.8864);
const LON = Number(process.env.CHIEF_WEATHER_LON ?? -78.8784);
const TZ = process.env.CHIEF_WEATHER_TZ ?? "America/New_York";
const LABEL = process.env.CHIEF_WEATHER_LABEL ?? "Buffalo";
const TIMEOUT_MS = Number(process.env.CHIEF_WEATHER_TIMEOUT_MS ?? 5000);

export interface TodayWeather {
  label: string;
  high: number;
  low: number;
  conditions: string;
}

// WMO weather codes -> short, glanceable conditions text.
function wmoToText(code: number): string {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorms";
  return "mixed";
}

export async function getTodayWeather(): Promise<TodayWeather | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
    `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}&forecast_days=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      daily?: {
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        weather_code?: number[];
      };
    };
    const d = data.daily;
    const high = d?.temperature_2m_max?.[0];
    const low = d?.temperature_2m_min?.[0];
    const code = d?.weather_code?.[0];
    if (high == null || low == null || code == null) return null;
    return { label: LABEL, high: Math.round(high), low: Math.round(low), conditions: wmoToText(code) };
  } catch {
    return null; // timeout, network, parse: omit the weather line, don't break the briefing
  } finally {
    clearTimeout(timer);
  }
}
