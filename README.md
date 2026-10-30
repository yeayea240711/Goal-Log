# Goal Log

A personal accountability calendar. Say what you need to do, and Goal Log keeps reminding you until it's done. If you miss something, it marks it with an ✕ and asks you why.

## What it does

- **Quick add.** Type or say "Interview Nov 2 at 7am, start reminding me Nov 1 at 7pm, every hour". Goal Log fills in the task, the time and the reminders, and you check them before saving.
- **Nag levels.** Light (one reminder), Normal (every 2 hours) or Can't miss (every hour).
- **Reminder emails.** Your Google script checks every 5 minutes and emails you from Gmail when a reminder is due. It works even when the site is closed, and your phone buzzes wherever Gmail is signed in.
- **Morning plan.** At 7 AM you get an email with today's tasks and anything still waiting on an answer.
- **Did you do it?** An hour after a task's time, you get an email. Open Goal Log, mark it done, or mark it missed and say why.
- **Pop-ups.** While Goal Log is open in a tab or installed as an app, you also get a notification on that device.
- **Last 7 days.** A scorecard of done, missed and waiting, with your reasons for each miss.
- **Workouts.** Lift Log lives inside Goal Log: workouts, sets, rest timer, diet, body weight and progress charts, all saved to the same Google Sheet (in a tab called **Lift**). On your workout days you get emails at 5, 7 and 9 PM until you finish a workout, and a skipped workout day shows up under "Did you do these?" so you can say why.

## What's here

| File | What it is |
| --- | --- |
| `index.html` | The app. Sign in with your passcode, add tasks, see your calendar. |
| `workouts.html` | Workouts (Lift Log). To bring in your old Lift Log, open **Progress → Bring in your old Lift Log** and pick your `lift-log-import.json` file. |
| `parse.js` | Reads dates and reminder times out of what you type. |
| `google/Code.gs` | The Google script. It saves tasks to your Google Sheet and sends the reminder emails. |
| `config.js` | Holds the link to your Google script. While it's empty the app runs in demo mode: tasks stay in that browser and no emails go out. |
| `manifest.webmanifest`, `sw.js`, `img/` | Let you install Goal Log on your phone or computer like an app. |

## One-time setup (about 10 minutes, free)

1. **Put the site online.** In this repo, open **Settings → Pages**, set the branch to `main` and the folder to `/ (root)`, then press **Save**. Your link will be `https://yeayea240711.github.io/Goal-Log/`.
2. **Make the Sheet.** At [sheets.new](https://sheets.new), create a blank Google Sheet and name it **Goal Log**.
3. **Add the script.** In the Sheet, open **Extensions → Apps Script**. Delete the sample code and paste in all of `google/Code.gs`. Change `change-me` on the `PASSCODE` line to a passcode only you know. Press **Save**.
4. **Set your time zone.** In Apps Script, click the gear (**Project Settings**) and set **Time zone** to yours, for example `(GMT-06:00) Central Time - Chicago`. Emails show times in this zone.
5. **Start the reminders.** In the function menu at the top, pick **setup** and press **Run**. Google will ask you to allow access. Pick your account, then **Advanced → Go to Goal Log (unsafe) → Allow**. Google shows this warning for any script you write yourself.
6. **Publish the script.** Press **Deploy → New deployment**. Click the gear and pick **Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then press **Deploy**.
7. **Copy the Web app URL** that ends in `/exec` and put it in `config.js` as `googleScriptUrl`.
8. **Sign in.** Open your Goal Log link, type your passcode, and press **Send a test email** under Reminders to check that emails arrive.

If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the link stays the same.

## Get it on your phone and computer

- **Pixel / Android (Chrome):** open your Goal Log link, tap the ⋮ menu, then **Add to Home screen → Install**.
- **iPhone (Safari):** open the link, tap **Share**, then **Add to Home Screen**.
- **Computer (Chrome or Edge):** open the link and click the install icon at the right end of the address bar.
- Under **Reminders** in the app, press **Turn on** next to **Pop-ups on this device**, and allow notifications.
- Make sure Gmail notifications are on for your phone, so reminder emails buzz it. To make them stand out, add a Gmail filter for emails from yourself with the subject words "Goal Log" or "⏰", and label them **Goal Log**.

## Settings in `Code.gs`

| Setting | What it does |
| --- | --- |
| `PASSCODE` | What you type to sign in. |
| `EMAIL` | Where reminders go. Blank means the Google account that runs the script. |
| `SITE_URL` | Your Goal Log link, used for the button in emails. |
| `MORNING_HOUR` | Hour for the morning plan email (0 to 23). `-1` turns it off. |
| `ASK_AFTER_MIN` | How long after a task's time you get the "did you do it?" email. |
| `WORKOUT_HOURS` | Hours (0 to 23) for workout-day reminder emails. Pick your workout days on the Workouts page under History. |

Gmail lets a free Google account send about 100 script emails a day, which covers several hourly reminders a day with room to spare.
