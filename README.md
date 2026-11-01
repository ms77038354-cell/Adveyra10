# ADVEYRA AI STUDIO — Gemini Edition (Updated)

Private browser-based AI coding workspace built with Node.js, Express and Google Gemini.

## Included

- Admin login with bcrypt password hash and signed session cookie.
- Gemini chat agent with tools to list, read, create and update workspace files.
- File tree, text editor, create/rename/delete file, create folder and refresh.
- Upload an individual file and import/extract a ZIP project into the workspace.
- Automatic backups before replacing or deleting existing text files and before ZIP import overwrites.
- Static HTML preview served from the workspace, with relative CSS/JS/assets and no-cache headers.
- Preview loads the latest saved editor contents; refresh reloads the selected file from disk.
- Export the workspace as ZIP.
- Optional GitHub push using a server-side GitHub token.
- Diagnostics and Render deployment configuration.

## Render deployment

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Root directory: blank (repository root)

### Required Render environment variables

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH` — bcrypt hash, not the plain password
- `SESSION_SECRET` — random secret of at least 32 characters
- `GEMINI_API_KEY` — Google AI Studio API key
- `GEMINI_MODEL` — default `gemini-3.1-flash-lite`

### Optional GitHub push variables

The service's Render GitHub connection (used for deploying the service) does not automatically authorize the application's **Push to GitHub** button. The button uses the GitHub REST API and requires all four variables below:

- `GITHUB_TOKEN` — fine-grained personal access token with access to the target repository and **Contents: Read and write** permission
- `GITHUB_OWNER` — GitHub username or organization that owns the target repository
- `GITHUB_REPO` — exact repository name
- `GITHUB_BRANCH` — target branch, normally `main`

Add these under Render → your Web Service → Environment. Never put the token in source code, the ZIP, browser JavaScript, or chat. After adding/updating environment variables, save and redeploy. Then run Diagnostics; GitHub integration should show the configured owner/repository.

## Using file import and editing

- **Upload file** uploads one file (up to 2 MB) into a relative workspace path.
- **Import ZIP** extracts a project archive into the workspace (up to 25 MB upload, 100 MB expanded content, 500 files).
- Existing files with matching paths are backed up before being replaced.
- `.env`, `.git`, `node_modules`, and `.adveyra-*` content is intentionally excluded from ZIP imports to avoid importing secrets or bulky dependency folders.
- Select a text file to view/edit it; click **Save file** to write changes.

## Preview limits

The Preview supports static HTML projects and workspace-relative CSS, JavaScript, images and other static assets. It is not a full Node/React/Vite/Next.js build runtime and does not start backend servers or run arbitrary terminal commands. For a framework app, build it in an appropriate runtime/hosting workflow and preview its generated static output (for example `dist/index.html`) where possible.

## Important hosting note

Render's free web-service filesystem is ephemeral. Workspace files may be lost when the service is restarted, redeployed or moved to another instance. Use **Export ZIP** and **Push to GitHub** regularly, or attach persistent storage if your hosting plan supports it. GitHub push does not delete unrelated files already present in the repository; it adds/updates files from the workspace.

## Security

- Keep all secrets in Render environment variables.
- Do not upload `.env` files or secrets into the workspace.
- Use a GitHub token limited to the target repository.
- Rotate any credentials that have been exposed in screenshots or shared chats.


### AI provider setup
Sign in and open **AI Settings** to select Gemini or OpenAI, choose a model, save an API key, and test provider authentication. Keys are encrypted on the server using `SESSION_SECRET`. Keep `SESSION_SECRET` stable. For Render Free, use Render environment variables for durable secrets because local disk can reset. OpenAI API billing is separate from ChatGPT subscriptions. The project variable vault stores encrypted values but does not yet inject them into a running backend process.
