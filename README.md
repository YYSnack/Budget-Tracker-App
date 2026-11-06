# Budget Tracker

Phone-first personal budget app (installable PWA). No accounts and no server: all data lives in
the browser's IndexedDB on the device. Currency: USD base, any other currency per entry.

## Run

```bash
npm install
npm run dev        # dev server on your network (vite --host)
npm test           # unit tests (logic + database operations)
npm run build      # production build in dist/
npm run preview    # serve the production build
```

## Notes
- Data is per browser and per origin (`localhost` and `192.168.x.x` are different stores).
  Use More → Export & backup to move or protect your data.
- Exchange rates come from the free Frankfurter (ECB) API and are locked onto each entry.
  Offline, type the rate by hand.
- Projected recurring items are not counted until you confirm them.
- Categories are archived, never deleted.
