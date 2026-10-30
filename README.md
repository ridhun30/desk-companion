# Desk Companion

A fullscreen desk dashboard for a spare Android phone (built for a OnePlus Nord 2) on a stand:

- **Clock, date and weather.** Weather comes from [Open-Meteo](https://open-meteo.com) and needs no API key.
- **Outlook / Microsoft 365 agenda** for today and tomorrow, with "Now" and "in 15 min" badges.
- **Pomodoro timer** with 25/5/15 cycles, a chime, vibration and notifications. You can pin a to-do as the current focus.
- **To-do list** that is saved on the phone. You can reorder items and clear completed ones.

It works offline once loaded, keeps the screen awake, and nudges the layout a few pixels every minute to protect the OLED screen from burn-in.

The app is plain HTML, CSS and JS with no build step. A small Python server (`server.py`) serves it and reads your Microsoft 365 calendar (via Microsoft Graph or a published ICS link).

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

The setup script installs Python and the calendar libraries, creates `config.json` from `config.example.json` and registers the boot script.

### 3. Connect your Microsoft 365 (work) calendar

There are two ways. Try **A** first, because it takes two minutes. If your company has turned it off, use **B**.

> Check that your company's IT policy allows showing your work calendar on a personal device. With either option, events stay on the phone and are never uploaded anywhere else.

#### A. Publish the calendar (simplest)

1. In Outlook on the web, open Settings → Calendar → Shared calendars → **Publish a calendar**.
   - If that section is missing, your admin has disabled publishing. Use **B**.
2. Pick your calendar and choose **Can view all details**. Click **Publish**, then copy the **ICS** link.
3. Put the link in `config.json`:

   ```json
   { "ics_urls": ["https://outlook.office365.com/owa/calendar/.../calendar.ics"] }
   ```

Published calendars update every few minutes, and the server re-reads them every 10 minutes. Anyone with the link can see your calendar, so keep it private (`config.json` is git-ignored).

#### B. Sign in with Microsoft Graph

This reads your calendar directly with read-only access (`Calendars.Read`). You sign in once, and the server keeps itself signed in.

1. **Register an app** in your company's directory. Most tenants let any employee do this; if yours doesn't, ask IT to do these steps for you:
   1. Go to [entra.microsoft.com](https://entra.microsoft.com) → Applications → **App registrations** → **New registration**.
   2. Name it `Desk Companion` and choose *Accounts in this organizational directory only*. Leave the redirect URI empty and click **Register**.
   3. On the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
   4. Go to **Authentication**, set *Allow public client flows* to **Yes**, and click **Save**.
   5. Go to **API permissions** → Add a permission → Microsoft Graph → **Delegated** → `Calendars.Read` → Add. If it says admin consent is required, ask IT to click *Grant admin consent*.
2. **Configure it** in `config.json`:

   ```json
   {
     "microsoft": {
       "client_id": "<Application (client) ID>",
       "tenant": "<Directory (tenant) ID>"
     }
   }
   ```

3. **Sign in** from Termux:

   ```sh
   python server.py --login
   ```

   It prints a code. Open https://microsoft.com/devicelogin on any device, enter the code and sign in with your work account. That's it. Use `python server.py --logout` to forget the sign-in. The token is stored in `.ms-token.json`, which only you can read and which is git-ignored.

If the sign-in expires (for example after a password change or a long time offline), the agenda shows a message asking you to run `--login` again. If sign-in is refused with a Conditional Access or "device code flow blocked" error, your company blocks this sign-in method, and only IT can allow it. In that case use option A, or ask IT.

You can use both A and B together, and also add personal calendars to `ics_urls`. Duplicate meetings are shown once.

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
server.py              static file server + /api/agenda (merges all calendars into JSON)
microsoft.py           Microsoft Graph calendar: device code sign-in, token refresh
public/index.html      markup
public/styles.css      landscape 3-column layout, stacked layout in portrait
public/app.js          clock, weather, agenda, to-do, Pomodoro, settings
public/sw.js           offline cache
scripts/               Termux setup and start scripts
tests/                 ICS and Microsoft Graph tests
```
