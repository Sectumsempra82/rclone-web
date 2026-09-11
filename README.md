<p align="center"><img src=".github/icon.png" width="169" /></p>

# Rclone Web
A lightweight web UI for [**rclone**](https://rclone.org/). Use it to manage remotes, mounts, serves, transfers, and common rclone actions from a browser.

![screenshot](.github/screenshot.png)

## Persistent queue in this fork

### Local Docker test stack

Build with `docker build -t rclone-web:local .`, then double-click `start-local-test.cmd` (or run `./start-local-test.ps1`). This starts `compose.local.yaml`: this GUI image on `127.0.0.1:5572` and the official rclone RC backend on `127.0.0.1:5573`. The launcher opens a browser with generated local test credentials. Node 24 runs inside the image; no host Node installation is needed for this stack.

In **Remotes**, copy folders from **Source** to **Destination**, then inspect **Transfers**. Sample files range from 1 to 64 MiB; the test backend is limited to 4 MiB/s to keep progress visible. Test data, backend configuration and credentials live under ignored `.work/local-test/`; the queue lives in the `rclone-web-local_queue-data` Docker volume. This isolated backend does not mount NAS or personal files. The launcher preserves existing test files and configuration.

Stop with `docker compose -f compose.local.yaml down`; this keeps data and queue state. Rerun the launcher to start again. To publish, tag the image for your registry, authenticate with `docker login`, and push that tag. Registry credentials are separate from generated GUI test credentials.

The GUI server includes a persistent per-file queue. It connects to an existing, unmodified rclone RC backend; it does not start, reconfigure, or stop that backend. File contents travel through rclone, never through the GUI server or browser.

Run **one GUI service instance** per queue database, with Node.js 24 LTS (the build requires Node 22.12 or newer). No additional npm dependencies are required by the server; its SQLite database uses Node's built-in SQLite module, which is experimental in Node 24.

```sh
npm ci
npm run build
npm run build:service
# Set RCLONE_URL, RCLONE_USER, RCLONE_PASS_FILE, then:
npm start
```

`RCLONE_URL` is the existing RC API address as reached by the service. `RCLONE_PASS_FILE` points to a file containing its password (a `RCLONE_PASS` environment variable is also supported). Log into the GUI with the same backend credentials and its browser-reachable RC URL. The service verifies both connections address the same rclone instance. Its default address is `127.0.0.1:5572`; set `HOST=0.0.0.0` for LAN access. `QUEUE_TRANSFERS` controls this queue's concurrency (default 4), independently of rclone's global settings. Persist `QUEUE_DATA_DIR` (default `./queue-data`) on a local filesystem, not SMB/NFS.

`Dockerfile` and `compose.queue.yaml` package the GUI and queue as **one container**, pointing to your existing rclone backend. Set the variables required by Compose, including `RCLONE_PASSWORD_FILE`, then use `docker compose -f compose.queue.yaml up -d --build`. The secret file must be readable by the container's `node` user. Port 5572 must be available; this command does not replace an existing GUI automatically. The container needs no data-share mounts: rclone retains those.

- **Stop queue** persists a pause and starts no more files. Active files finish; **Resume queue** continues pending work, including after the browser closes or the GUI service restarts.
- New Copy/Move actions go through the queue. Folder entries expand into files and subfolders on the server. Removing an unexpanded folder skips that subtree. Empty destination folders are preserved.
- Each Copy/Move submission is a queue group, with its own table, selection, pagination, and persistent Stop/Resume button. Group Stop drains active files and skips pending files in that group; other groups continue. Global Resume preserves individual group stops. Queue group numbers identify submissions, not the separate per-file rclone job IDs in activity. Older queue entries without saved group membership are preserved in an "Existing queue" group.
- Group and overall progress use completed file sizes plus live bytes, divided by total retained file size, never file counts or an average of group percentages. The overall bar sits below the page header outside collapsible sections and covers managed queue groups. Completed counters survive service restarts; completed groups stay visible until a new batch is submitted after the queue empties. Removing work adjusts the total. Folder discovery or unavailable sizes make the percentage indeterminate; a completed/skipped file counts as resolved work, not network traffic. Pre-upgrade completions were not stored and cannot be reconstructed, so migrated progress starts with remaining work.
- The queue table offers individual removal and selection of up to 100 entries per page. Removal never deletes files, and entries already claimed by a worker are protected.
- Moves remove successfully moved source **files** using rclone's normal move operation. Empty source directories remain, avoiding cleanup of directories whose queued contents were deliberately removed.
- Only this service's submitted jobs are managed. Existing external jobs remain visible in activity but are not adopted. The per-row activity Stop button still cancels that rclone job explicitly.
- Queue entries and pauses persist in SQLite. Completed-file history remains rclone's bounded history. If rclone restarts, a job expires, or a submission outcome is uncertain, affected entries require review instead of automatically replaying a possibly completed move. Check destination and active jobs, remove the failed queue entry, and resubmit if needed.
- Per-file scheduling adds RC requests and database writes compared with a single bulk `rclone copy`, especially for tiny files. Bulk scripts remain available independently. Do not remove the queue volume during upgrades.

Checks: `npm run test:queue` runs backend tests; `npx playwright test --config playwright.transfers.config.ts` runs isolated UI fixtures after a build (Chrome required). For the real-rclone integration test, set `RCLONE_TEST_BIN` to a local rclone executable and run `node --experimental-sqlite --test dist-server/server/queue.integration.test.js`. All integration data is created in a fresh temporary directory.

The upstream usage below launches the stock GUI; it does not host this fork's queue API.

## Usage
Install [rclone](https://rclone.org/install/) and run:

```bash
rclone gui
```

Rclone opens the UI in your browser and prints generated credentials on startup. Pass `--user`, `--pass`, or `--addr` to override the defaults. See `rclone gui --help` for the full list of flags.

#### Screens
- **Dashboard** – overview of remotes, mounts, serves, running operations, and global transfer stats.
- **Remotes** – create, edit, and delete rclone remotes, with live usage per remote.
- **Mounts** – list active remote mounts, unmount them, or create new ones.
- **Serves** – list, start, and stop serve endpoints (HTTP, WebDAV, SFTP, …).
- **Transfers** – live and recent transfer jobs, with the option to stop running ones.
- **Settings** – tune performance flags, configure logging, and edit the rclone config file.

## Docker
The easiest way to run the UI is through the official rclone Docker image. After starting the container, open `http://localhost:5522/login?url=localhost:5533` in your browser. The `url` param tells the GUI where to reach the RC API.

#### Simple
```bash
docker run -d \
  --name rclone-gui \
  -p 5522:5522 \
  -p 5533:5533 \
  -v ~/.config/rclone:/config/rclone \   # if you want to use a local config you already have
  -v /path/to/data:/data \               # if you want to mount other folders, eg for cache
  rclone/rclone:latest \
  gui \
  --addr=0.0.0.0:5522 \
  --api-addr=0.0.0.0:5533 \
  --user gui-user \						# skip to auto-generate a user
  --pass 'change-this-password' 		# skip to auto-generate a pass
```

#### Compose
```yaml
services:
  rclone-gui:
    image: rclone/rclone:latest
    container_name: rclone-gui
    restart: unless-stopped
    ports:
      - "5522:5522"
      - "5533:5533"
    volumes:
      - ~/.config/rclone:/config/rclone
      - /path/to/data:/data
    command:
      - gui
      - --addr=0.0.0.0:5522
      - --api-addr=0.0.0.0:5533
      - --user=gui-user
      - --pass=change-this-password
```

Mount `~/.config/rclone` if you want to reuse an existing local config. Mount any additional folders, such as `/path/to/data`, when rclone needs access to local files or cache locations.

You can omit `--user` and `--pass` to let rclone generate credentials.

## Development
```bash
npm install
npm run dev
```

Useful scripts:

- `npm run build` builds the web app.
- `npm run lint` checks formatting and lint rules with Biome.
- `npm test` builds the app and runs the Playwright test suite against `rclone gui`.

## Contributing
We welcome new contributors!

Areas where help is especially useful:
- Bug fixes
- Accessibility improvements
- Playwright Tests
- Translations ([**Web**](https://github.com/rclone/rclone-web/tree/main/src/languages) or [**RC**](https://github.com/rclone-ui/rclone-i18n))

## License
MIT

<br />
<br />

<div align="center">
<sub>Made with ☁️ for the <a href="https://discord.gg/rclone">rclone community</a></sub>
</div>
