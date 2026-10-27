# SpendWise — Daily Expense Buddy

SpendWise is a responsive personal expense tracker built with HTML, CSS, and vanilla JavaScript. It uses this browser's LocalStorage for transactions, categories, budgets, currency, and theme preferences. It does not provide authentication, cloud storage, or synchronization between devices.

## Run locally

Open `index.html` directly in a modern browser. No installation, server, or build step is needed. Internet access is only needed to load the optional Google Fonts; the application itself and its charts work without a charting library.

## Data and backups

Your records are saved in LocalStorage for the current browser profile. Use **Settings → Export JSON backup** regularly to keep a copy. JSON import validates the entire backup before replacing current local records. Use **Load sample data** in Settings if you want to explore with clearly marked example records; it will not overwrite existing data.

Clearing browser site data also deletes SpendWise data. LocalStorage is not encrypted or a secure account system, so do not use it to store highly sensitive financial information.
