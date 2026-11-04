# 215 Happy Hour

Philadelphia's happy hour source, since 2009. This repo builds 215happyhour.com as a fast static site from a Google Sheet, then uploads it to HostGator.

```
Google Sheet  ──►  GitHub Actions (node build.js)  ──►  HostGator /215happyhour.com
 (you edit)         every hour, or on demand              (the live site)
```

## What's in here

| Path | What it is |
| --- | --- |
| `build.js` | Builds every page into `dist/`. No packages to install. |
| `site.config.json` | Site name, URL, contact email, newsletter form link. |
| `data/venues.csv` | Sample listings. Import this into Google Sheets to start your sheet. |
| `src/styles.css`, `src/app.js` | Design and the live "happening now" / filter code. |
| `static/.htaccess` | HTTPS, no-www, 404 page, and redirects from the 2009 URLs (`monday.html` → `/monday/`). |
| `.github/workflows/deploy.yml` | Builds and uploads to HostGator. |

Pages it creates: home (live now), Monday–Sunday, late night, weekend, every neighborhood, every bar, about (with the 2011 archive), for bars, 404, `sitemap.xml`, `robots.txt`.

## One-time setup

### 1. Make the Google Sheet
1. In Google Sheets: **File → Import → Upload** `data/venues.csv`, "Replace spreadsheet".
2. Keep the header row exactly as is. One row = one happy hour block. A bar with a weekday and a late-night happy hour gets two rows with the same name.
3. **File → Share → Publish to web** → pick the sheet tab → **Comma-separated values (.csv)** → Publish. Copy the link.

| Column | Example | Notes |
| --- | --- | --- |
| name | McGillin's Olde Ale House | Rows with the same name become one bar page |
| neighborhood | Midtown Village | Creates the neighborhood page |
| address | 1310 Drury St | |
| phone, website, instagram | (215) 735-5562 | Optional |
| lat, lng | 39.9497, -75.1622 | Optional for now; used by the map later. Right-click a spot in Google Maps to copy |
| days | Mon-Fri | `Daily`, `Mon-Fri`, `Sun-Thu`, `Mon,Wed,Fri` |
| start, end | 16:00, 18:00 | 24-hour time. Use `23:59` for midnight |
| deals | $5 drafts\|$1 oysters | Separate deals with a `\|` |
| tags | beer,food,oysters | Drives the filter chips: beer, wine, cocktails, food, oysters |
| vibe | sports bar | Shown on the bar page |
| verified | 2026-11-04 | Date you last confirmed it. Older than 120 days shows "Needs re-check" |
| featured | yes | Paid placement. Highlighted and listed in "Featured bars" |
| classic | yes | Was on the original 2009–2012 site. Gets the "215 Classic" badge |
| sample | yes | Placeholder. **Delete every `sample = yes` row before launch** |
| active | yes | Set to `no` to hide a row without deleting it |

The build warns about rows that break Pennsylvania rules (more than 4 hours a day, more than 24 hours a week, or past midnight). Those are usually typos.

### 2. Put the code on GitHub
Create a private repo, e.g. `215happyhour`, and push this folder to the `main` branch.

### 3. Add GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `SHEET_CSV_URL` | The "Publish to web" CSV link from step 1 |
| `FTP_SERVER` | From HostGator cPanel → FTP Accounts (often `ftp.215happyhour.com` or the server IP) |
| `FTP_USERNAME` | Your cPanel FTP username |
| `FTP_PASSWORD` | Its password |

If you create an FTP account that already opens inside `public_html`, (for example one created just for the 215happyhour.com folder), change `server-dir` in `deploy.yml` to `./`. If FTPS fails to connect, change `protocol: ftps` to `ftp`.

### 4. First deploy
215happyhour.com is an addon domain, so its files live in the `215happyhour.com` folder in your home directory, not `public_html`. Leave `.well-known` and `cgi-bin` there. Back up anything else in that folder, then go to **Actions → Build and deploy to HostGator → Run workflow**. In HostGator, make sure the free SSL certificate is on for the domain, since `.htaccess` sends everyone to `https://215happyhour.com` (www redirects there).

### 5. Tell Google
Add the site in [Google Search Console](https://search.google.com/search-console), submit `https://215happyhour.com/sitemap.xml`, and set up a Google Business Profile.

## Day to day
- **Add or change a bar:** edit the sheet. The site rebuilds every hour, or hit **Run workflow** to publish now.
- **Change the design or copy:** edit files in `src/` or `build.js`, commit, push. It deploys automatically.
- **Preview on your computer:** `node build.js`, then open `dist/index.html` through any local server (`npx serve dist`).
- **Newsletter:** put your MailerLite (or other) embedded form's `action` URL in `site.config.json` → `newsletterFormAction`.

## Next up
1. Replace the sample rows with real bars (start with 150+ in the busiest 8 neighborhoods).
2. Map view on the home page (uses the lat/lng columns).
3. "Claim your listing" form for bar owners, and the monthly stats email.
4. Analytics (Google Analytics 4 or Plausible) so you can show bars their numbers.
