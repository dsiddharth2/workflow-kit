import json
import sys
import urllib.request
import urllib.error


def fetch_time(city):
    url = f"https://worldtimeapi.org/api/timezone"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            zones = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": str(exc)})

    needle = city.lower().replace(" ", "_")
    matches = [z for z in zones if needle in z.lower()]
    if not matches:
        return json.dumps({"ok": False, "error": f"No timezone found for '{city}'"})

    zone = matches[0]
    detail_url = f"https://worldtimeapi.org/api/timezone/{zone}"
    try:
        with urllib.request.urlopen(detail_url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": str(exc)})

    return json.dumps({
        "ok": True,
        "timezone": data.get("timezone"),
        "datetime": data.get("datetime"),
        "utc_offset": data.get("utc_offset"),
        "day_of_week": data.get("day_of_week"),
        "abbreviation": data.get("abbreviation"),
    })


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "London"
    print(fetch_time(city))
