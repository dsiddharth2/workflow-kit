import json
import sys
import urllib.request
import urllib.error


def fetch_weather(city):
    url = f"https://wttr.in/{urllib.request.quote(city)}?format=j1"
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": str(exc)})

    current = data.get("current_condition", [{}])[0]
    area = data.get("nearest_area", [{}])[0]
    area_name = (area.get("areaName") or [{}])[0].get("value", city)
    country = (area.get("country") or [{}])[0].get("value", "")

    return json.dumps({
        "ok": True,
        "location": f"{area_name}, {country}",
        "temp_c": current.get("temp_C"),
        "temp_f": current.get("temp_F"),
        "feels_like_c": current.get("FeelsLikeC"),
        "humidity": current.get("humidity"),
        "description": (current.get("weatherDesc") or [{}])[0].get("value", ""),
        "wind_speed_kmph": current.get("windspeedKmph"),
        "wind_dir": current.get("winddir16Point"),
        "visibility_km": current.get("visibility"),
        "uv_index": current.get("uvIndex"),
    })


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "London"
    print(fetch_weather(city))
