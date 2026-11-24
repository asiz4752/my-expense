# Daily Expense Tracker

A responsive expense tracker built with plain HTML, CSS and JavaScript, using Firebase Firestore for real-time storage and Chart.js for charts. There is no build step.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `style.css` | Styling and responsive layout |
| `app.js` | App logic, Firestore sync, charts |
| `firebase-config.js` | **Paste your Firebase keys here** |

## Setup

### 1. Create a Firebase project
1. Go to https://console.firebase.google.com and click **Add project**.
2. Open **Build -> Firestore Database -> Create database**. Choose a region near you (e.g. `asia-south1` for Mumbai) and start in **production mode**.

### 2. Get your config keys
1. Click the gear icon, then **Project settings -> General**.
2. Under **Your apps**, click the **</>** (Web) icon and register an app (any nickname).
3. Copy the `firebaseConfig` values shown.

### 3. Paste the keys
The Firebase project configuration is in **`firebase-config.js`**. Replace it with your own project values if needed. You can also change `CURRENCY` / `LOCALE` at the bottom of that file.

### 4. Set Firestore rules
In **Firestore Database -> Rules**, paste the following and click **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /expenses/{id} { allow read, write: if true; }
    match /incomes/{id}  { allow read, write: if true; }
  }
}
```

> These rules are open, so anyone who has your app URL and project ID could read or write your data. They are fine for local, private use. If you deploy publicly, add Firebase Authentication and restrict rules to `request.auth.uid == "<your-uid>"`.

### 5. Run it
The app uses ES modules, so it must be served over http. Opening `index.html` by double-click will not work.

- **VS Code:** install the *Live Server* extension, right-click `index.html`, then **Open with Live Server**.
- **Python:** run `python -m http.server 5500` in this folder, then open http://localhost:5500.
- **Free hosting (optional):** `npm i -g firebase-tools`, then `firebase login`, `firebase init hosting` (public dir = this folder), `firebase deploy`.

## How the data is stored

- `expenses/{autoId}` holds `{ category, amount, date: "YYYY-MM-DD", note, createdAtMs }`
- `incomes/{YYYY-MM}` holds `{ month, amount }`. One document per month, so saving again updates it.

The app listens to last month and this month's expenses in real time. Open it on two devices and changes appear on both instantly. No composite index is needed.

## Features

- Add, edit and delete expenses, synced live with Firestore
- Preset category suggestions, plus custom categories you can type
- Monthly income per month, with remaining balance, a usage bar and a "safe to spend per day" figure
- Last month's total, with a same-period comparison so the comparison is fair mid-month
- Highest and lowest spending category, with their share of the total
- Doughnut chart with percentages and a colour-coded legend
- Day-by-day grouped list with daily totals, newest day first
- Mobile-friendly layout
