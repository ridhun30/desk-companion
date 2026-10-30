# Desk Companion

A fullscreen desk dashboard for a spare Android phone (built for a OnePlus Nord 2) on a stand:

- **Clock, date and weather.** Weather comes from [Open-Meteo](https://open-meteo.com) and needs no API key.
- **Outlook agenda** for today and tomorrow, with "Now" and "in 15 min" badges.
- **Pomodoro timer** with 25/5/15 cycles, a chime, vibration and notifications. You can pin a to-do as the current focus.
- **To-do list** that is saved on the phone. You can reorder items and clear completed ones.

It works offline once loaded, keeps the screen awake, and nudges the layout a few pixels every minute to protect the OLED screen from burn-in.

The app is plain HTML, CSS and JS with no build step. A small Python server (`server.py`) serves it and turns your Outlook calendar into JSON.

## Setup on the phone

### 1. Install the apps

From [F-Droid](https://f-droid.org) (the Play Store version of Termux is outdated), install:

- **Termux**
- **Termux:Boot** (optional; it starts the server automatically after a reboot). Open it once after installing.

### 2. Get the code

In Termux:

```sh
pkg install -y git gh
gh auth login                      # this repo is private
gh repo clone ridhun30/desk-companion
cd desk-companion
bash scripts/termux-setup.sh
```

The setup script installs Python and the calendar libraries, creates `config.json` and registers the boot script.

### 3. Connect your Outlook calendar

Publish your calendar to get an ICS link:

- **Outlook on the web / Outlook.com:** Settings → Calendar → Shared calendars → *Publish a calendar*. Pick your calendar, choose **Can view all details**, click **Publish**, then copy the **ICS** link.
- **Work or school Microsoft 365:** the same steps work if your organization allows publishing. If the option is missing, your admin has turned it off.

Paste the link into `config.json` (`nano config.json`):

```json
{ "ics_urls": ["https://outlook.office365.com/owa/calendar/.../calendar.ics"] }
```

You can list several calendars. The link is private, so `config.json` is git-ignored. Outlook refreshes published calendars every few minutes, and the server re-reads them every 10 minutes.

### 4. Run it

```sh
scripts/start.sh
```

Open **http://localhost:8080** in Chrome, tap ⋮ → **Add to Home screen** and launch it from there to get a fullscreen app. Allow location access for the weather (or search for a city in ⚙ Settings) and allow notifications for the Pomodoro alerts.

### 5. Keep it running (OnePlus specifics)

OxygenOS closes background apps aggressively. To stop that:

- Settings → Battery → Battery optimization → **Termux** → *Don't optimize*. Do the same for Termux:Boot.
- Lock Termux in the recent apps view (long-press its card → Lock).
- Developer options → **Stay awake** keeps the screen on while charging. The app also requests a screen wake lock, but this setting is the reliable fallback.
- Lower the brightness. The black background is easy on the OLED panel.

## Using it

| Action | How |
|---|---|
| Add a to-do | Type in the box and press Enter |
| Complete a to-do | Tap the circle (finished items move to the bottom) |
| Reorder, delete or focus | Tap the task text to show its actions |
| Pomodoro | ▶ start/pause, ↺ reset, ⏭ skip to the next phase |
| Settings | ⚙ in the top-right corner (clock format, units, location, timer lengths) |
| Fullscreen | ⛶ in the top-right corner |

## Development

```sh
pip install -r requirements.txt
python server.py            # http://localhost:8080
python -m unittest discover -s tests
```

To try the agenda without a real calendar, point it at the test fixture:

```sh
OUTLOOK_ICS_URL="file://$PWD/tests/fixtures/outlook.ics" python server.py
```

`server.py` options: `--port 8080` and `--host 0.0.0.0` (use this to open the dashboard from another device on your Wi-Fi). Service workers and the wake lock need `localhost` or HTTPS, so those features only work on the phone itself.

### Layout

```
server.py              static file server + /api/agenda (ICS → JSON, recurring events expanded)
public/index.html      markup
public/styles.css      landscape 3-column layout, stacked layout in portrait
public/app.js          clock, weather, agenda, to-do, Pomodoro, settings
public/sw.js           offline cache
scripts/               Termux setup and start scripts
tests/                 agenda tests with an Outlook-style ICS fixture
```
