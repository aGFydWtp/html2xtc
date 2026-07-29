# html2xtc API reference (for agents)

Base URL: `https://xtc.hr20k.com`

This document covers only the **unauthenticated conversion API**. Everything
else on this domain (`/api/library/*`, `/api/devices/*`, `/opds/*`,
`/internal/*`, and the auth endpoints under `/api/auth/*`) requires a logged-
in session or a shared secret and is **not** documented here — do not call
it without credentials, it will return 401.

Machine-readable schema: [openapi.json](https://xtc.hr20k.com/openapi.json).

Every endpoint below returns `405` (with an `Allow` header) if called with
the wrong HTTP method; that case is omitted from each endpoint's status
table to avoid repetition — use the method shown in its heading.

## Recommended path: async jobs

1. `POST /jobs` (or `/jobs/pdf`, `/jobs/text`, `/jobs/epub` for file uploads)
   returns `202` with a `jobId`.
2. Poll `GET /jobs/{jobId}` until `status` is `"completed"` or `"failed"`.
3. On `"completed"`, `GET /jobs/{jobId}/download` (or the `downloadUrl` field
   in the status response) returns the XTC file.

`POST /convert` is a synchronous alternative that returns the finished job in
one request, but the whole request must complete within roughly 150 seconds
server-side, so it only works for short pages. **Prefer `POST /jobs` unless
you specifically need the synchronous response.**

## Rate limiting

The conversion-starting endpoints — `POST /convert`, `POST /jobs`, `POST
/jobs/pdf`, `POST /jobs/text`, `POST /jobs/epub` — share **one** IP-based
budget: 50 requests per hour per client IP by default (fixed 1-hour window,
operator-configurable). Exceeding it returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds until the window resets>
```

`{"error": "..."}` — Wait the full `Retry-After` value before retrying;
retrying sooner just costs another request against the same window (it does
not itself count against the budget, since 429 is returned before the
counter would allow a new attempt).

`GET /jobs/{jobId}`, `GET /jobs/{jobId}/download`, `GET /download/{jobId}`,
and `GET /api/books` are **not** rate-limited, so poll status freely.
`POST /preview/text` has its own separate budget (default 20 requests/hour
per IP; see its section below) — it does not share the conversion budget.

### Polling interval

There is no published SLA for job duration. As a grounded reference point:
the service's own web UI polls `GET /jobs/{jobId}` every 4 seconds. Workflow
step timeouts bound the worst case rather than describe the typical case —
render steps allow up to 7 minutes per attempt (up to 2 retries) and the
final XTC-conversion step allows up to 12 minutes per attempt (up to 2
retries), so a job that hits transient failures can legitimately take much
longer than a normal successful run. **Poll every 4-5 seconds with a modest
backoff on repeated identical status; do not poll faster than once per
second.**

## Endpoints

### `POST /jobs` (recommended)

Creates an asynchronous conversion job from a URL.

```json
{ "url": "https://example.com/article", "mode": "extract", "layout": "vertical", "font": "BIZ UDMincho", "device": "x4" }
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Must be a public http(s) URL. Loopback, private (RFC 1918), link-local, CGNAT, and other reserved/non-public IP ranges (resolved via DNS if the host isn't a literal IP) are rejected, as is this service's own domain. |
| `mode` | no | `"full"` (default: render the page as-is) or `"extract"` (extract main article content first, degrading back to `"full"` automatically if extraction fails — always produces some output). Any other value is a `400`. |
| `layout` | no | `"horizontal"` or `"vertical"`. Invalid/omitted values silently fall back to a default (never a `400`). |
| `font` | no | A Google Fonts family name (letters, digits, spaces, hyphens; max 64 chars). Invalid or unavailable fonts silently fall back to a default. |
| `device` | no | `"x3"` (528x792 px output, default) or `"x4"` (480x800 px output). Invalid/omitted values silently fall back to `"x3"` (never a `400`). |

Success — `202`:

```json
{ "jobId": "<uuid>", "statusUrl": "/jobs/<uuid>" }
```

| Status | Meaning |
|---|---|
| 400 | body is not JSON / `url` missing / invalid `mode` / URL failed validation |
| 429 | rate limit exceeded (`Retry-After` header) |
| 503 | conversion is temporarily disabled by the operator |
| 500 | job creation failed |

### `GET /jobs/{jobId}`

Poll job status. `jobId` must be a UUID.

```json
{ "jobId": "<uuid>", "status": "converting" }
```

- `status` progresses `"queued"` -> (`"preparing"` for `/jobs/text` and
  `/jobs/epub` only) -> (`"rendering"`, absent for `/jobs/pdf`) ->
  `"converting"` -> `"completed"` | `"failed"`.
- On `"completed"`: also includes `"downloadUrl": "/jobs/{jobId}/download"`.
- On `"failed"`: also includes `"error": "<message>"`.
- `400` if `jobId` is not a UUID; `404` if unknown or past retention
  (roughly 1 day for the job record; the output file itself expires after
  roughly 24 hours even if the job record still exists).

### `GET /jobs/{jobId}/download`

Downloads the finished XTC file as an attachment.

| Status | Meaning |
|---|---|
| 200 | XTC bytes, `Content-Type: application/octet-stream` |
| 400 | `jobId` is not a UUID |
| 409 | job exists but is not finished yet — body includes `{"status": "..."}` |
| 404 | unknown `jobId`, job failed, or the output expired (~24 hours) |

### `POST /jobs/pdf`

Uploads a local PDF file for conversion. Skips page rendering; the PDF is
converted directly.

```http
POST /jobs/pdf
Content-Type: application/pdf
Content-Length: <bytes>
X-File-Name: <base64url of the UTF-8 filename>
X-Pdf-Options: <base64url of a PdfConvertOptions JSON object>

<PDF bytes>
```

- `Content-Type` must be `application/pdf` or `application/x-pdf` (415
  otherwise).
- `Content-Length` is required (411 if missing, 400 if not a positive
  integer). Default upload limit is 48 MiB (413 if exceeded).
- `X-File-Name` is optional: base64url-encode a UTF-8 filename. Used only for
  display/title purposes, never trusted as a path. A bad value silently
  falls back to a default filename rather than erroring.
- `X-Pdf-Options` is optional: base64url-encode the JSON form of
  `PdfConvertOptions` (see openapi.json for the full schema — page range,
  rotation, crop, fit, margin, threshold, dithering, invert, `device`
  `"x3"`|`"x4"`). Omit to use defaults. Values are validated strictly:
  out-of-range fields are a `400`, never silently clamped — an invalid
  `device` is a `400` too, unlike the fail-soft `device` on `POST /jobs`
  above.
- Request body must be sent as raw bytes, not multipart/form-data.

Success — `202`: same `{"jobId", "statusUrl"}` shape as `POST /jobs`.

| Status | Meaning |
|---|---|
| 400 | bad `Content-Length`, bad `X-Pdf-Options`, or upload/declared size mismatch |
| 411 | `Content-Length` missing |
| 413 | declared size exceeds the upload limit (48 MiB default) |
| 415 | `Content-Type` is not `application/pdf`/`application/x-pdf` |
| 429 | rate limit exceeded (shared with `/convert` and `/jobs`) |
| 503 | conversion is temporarily disabled by the operator |
| 500 | storage or job creation failure |

**Not supported (by design):** reflowing PDF text, changing font/size/line
spacing, OCR, password-protected/encrypted PDFs, per-page settings, canceling
a job after it starts, uploads over 48 MiB.

### `POST /jobs/text`

Uploads a plain-text or Markdown (`.txt`/`.md`/`.markdown`) file, reflows it
for reading, then converts it.

```http
POST /jobs/text
Content-Type: text/plain
Content-Length: <bytes>
X-File-Name: <base64url of the UTF-8 filename>
X-Text-Options: <base64url of a TextConvertOptions JSON object>

<TXT bytes>
```

- `Content-Type` must be `text/plain`, `text/markdown`, or
  `application/octet-stream` (415 otherwise). It does not select the parser —
  `inputFormat` does — so a Markdown body may be sent as `text/plain`.
- `Content-Length` is required (411 if missing). Fixed upload limit: 5 MiB
  (413 if exceeded — this limit is not operator-configurable, unlike the PDF
  and EPUB upload limits).
- `X-File-Name`: same rules as `POST /jobs/pdf`.
- `X-Text-Options` is optional: base64url-encode the JSON form of
  `TextConvertOptions` (see openapi.json — `inputFormat`
  `"plain"`|`"aozora"`|`"markdown"`, character encoding, layout, font, font
  size, line height, margins, text align, blank-line handling, page numbers,
  title, author, `device` `"x3"`|`"x4"`). Omit to use defaults. Strict
  validation, same as PDF options — an invalid `device` is a `400`.
- Supported character encodings: UTF-8 (with or without BOM) and Shift_JIS /
  Windows-31J. UTF-16, EUC-JP, and ISO-2022-JP are rejected.
- Additional fixed limits: 2,000,000 characters, 200,000 lines, 100,000
  characters per line, 12 MiB of generated HTML.

Success — `202`: same `{"jobId", "statusUrl"}` shape.

| Status | Meaning |
|---|---|
| 400 | bad `Content-Length`, bad `X-Text-Options`, or upload/declared size mismatch |
| 411 | `Content-Length` missing |
| 413 | declared size exceeds 5 MiB |
| 415 | `Content-Type` is not `text/plain`/`text/markdown`/`application/octet-stream` |
| 429 | rate limit exceeded (shared with `/convert`, `/jobs`, `/jobs/pdf`) |
| 503 | conversion is temporarily disabled by the operator |
| 500 | storage or job creation failure |

### `POST /jobs/epub`

Uploads an EPUB file, splits it into per-chapter HTML, then converts it.

```http
POST /jobs/epub
Content-Type: application/epub+zip
Content-Length: <bytes>
X-File-Name: <base64url of the UTF-8 filename>
X-Epub-Options: <base64url of an EpubConvertOptions JSON object>

<EPUB (ZIP) bytes>
```

- `Content-Type` must be `application/epub+zip`, or `application/octet-stream`
  when `X-File-Name` decodes to a filename ending in `.epub` (415 otherwise).
- `Content-Length` is required (411 if missing). Default upload limit is 48
  MiB (413 if exceeded).
- `X-File-Name`: same rules as `POST /jobs/pdf`.
- `X-Epub-Options` is optional: base64url-encode the JSON form of
  `EpubConvertOptions` (see openapi.json — `layout` `"auto"`|`"horizontal"`|
  `"vertical"`, `font`, `fontSizePx` 12-40, `marginPx` 0-120,
  `chapterPageBreak`, `includeCover`, `includeTableOfContents`, `device`
  `"x3"`|`"x4"`). Omit to use defaults. An invalid `device` is a `400`.
- The request body's first 4 bytes must look like a ZIP file, or the request
  is rejected with `400` before any deeper EPUB parsing happens.

Success — `202`: same `{"jobId", "statusUrl"}` shape.

| Status | Meaning |
|---|---|
| 400 | bad `Content-Length`, bad `X-Epub-Options`, missing body, not a ZIP file, or upload/declared size mismatch |
| 411 | `Content-Length` missing |
| 413 | declared size exceeds the upload limit (48 MiB default) |
| 415 | `Content-Type` not accepted |
| 429 | rate limit exceeded (shared with `/convert`, `/jobs`, `/jobs/pdf`, `/jobs/text`) |
| 503 | conversion is temporarily disabled by the operator |
| 500 | storage or job creation failure |

**Not supported (by design):** DRM-protected EPUB, Fixed Layout EPUB,
scripted/interactive EPUB, video/audio, embedded fonts (a Google Fonts
family from `EpubConvertOptions.font` is substituted instead), canceling a
job after it starts, uploads over 48 MiB.

### `POST /preview/text`

Synchronously converts the *first part only* of a plain-text body (no file
upload, no job, nothing saved server-side) for a quick real-device-accurate
preview. Not part of the `/jobs`-family rate limit — it has its own budget.

```http
POST /preview/text
Content-Type: application/json

{ "text": "...", "options": { ...same TextConvertOptions as /jobs/text... } }
```

- `text`: max 4,000 Unicode code points and max 32 KiB of UTF-8 bytes (413 if
  either is exceeded). This is meant for previewing the start of a document,
  not converting a whole file — use `POST /jobs/text` for that.
- Whole request body capped at 64 KiB.
- Rate limit: 20 requests/hour per IP by default (separate budget from the
  conversion-starting endpoints above).

Success — `200`: the response body is the XTC bytes directly (not a JSON
job object), with `Content-Disposition: inline` and headers
`X-Xtc-Page-Count` and `X-Preview-Character-Count`.

| Status | Meaning |
|---|---|
| 400 | bad JSON, missing `text`, or invalid `options` |
| 413 | `text` too long, or request body over 64 KiB |
| 415 | `Content-Type` is not `application/json` |
| 422 | body normalizes to empty, or the generated PDF is too large |
| 429 | rate limit exceeded (own budget, `Retry-After` header) |
| 502 | rendering or conversion failed upstream |
| 504 | conversion timed out |
| 500 | internal error |

### `POST /convert` (short pages only, synchronous)

```json
{ "url": "https://example.com/article", "mode": "extract" }
```

Same `url`/`mode`/`layout`/`font`/`device` fields as `POST /jobs`. Success — `200`:

```json
{ "jobId": "<uuid>", "downloadUrl": "/download/<uuid>" }
```

The whole request must finish within roughly 150 seconds server-side. **Use
`POST /jobs` instead for anything but very short pages.**

| Status | Meaning |
|---|---|
| 400 | body is not JSON / `url` missing / URL failed validation |
| 405 | wrong HTTP method (`Allow` header set) |
| 422 | generated PDF too large, or conversion failed |
| 429 | rate limit exceeded (shared budget, see above) |
| 500 | internal error |
| 502 | upstream page-rendering failure |
| 503 | conversion is temporarily disabled by the operator |

### `GET /download/{jobId}`

Downloads the XTC file produced by `POST /convert`. `400` if `jobId` is not
a UUID, `404` if not found or expired (~24 hours).

### `GET /api/books`

Searches the synced Aozora Bunko (public-domain Japanese literature) catalog
by title or author. Not rate-limited.

```
GET /api/books?q=<query>&limit=<1-50, default 50>
```

Response: `{"books": [{"workId": "...", "title": "...", "subtitle": null,
"author": "...", "htmlUrl": "https://...", "cardUrl": "https://...",
"copyrighted": false}]}`. An empty/blank `q` returns `{"books": []}`.
`htmlUrl` (when present) can be passed directly as the `url` field to
`POST /jobs`.

## Size and concurrency limits

| Item | Default | Notes |
|---|---|---|
| Rendered PDF size (URL jobs) | 48 MiB | operator-configurable |
| Uploaded PDF size (`/jobs/pdf`) | 48 MiB | operator-configurable |
| Uploaded TXT size (`/jobs/text`) | 5 MiB | fixed, not configurable |
| TXT character/line limits | 2,000,000 chars / 200,000 lines / 100,000 chars per line | fixed |
| Generated HTML from TXT | 12 MiB | fixed |
| Uploaded EPUB size (`/jobs/epub`) | 48 MiB | operator-configurable |
| EPUB uncompressed total size | 192 MiB | operator-configurable |
| EPUB single-entry uncompressed size | 32 MiB | operator-configurable |
| EPUB ZIP entry count | 5,000 | operator-configurable |
| Generated HTML from EPUB | 32 MiB | operator-configurable |
| Conversion-starting endpoints rate limit | 50 requests/hour/IP | operator-configurable, shared across `/convert`+`/jobs`+`/jobs/pdf`+`/jobs/text`+`/jobs/epub` |
| `/preview/text` rate limit | 20 requests/hour/IP | operator-configurable, separate budget |

All of the above defaults can be changed by the operator; treat them as
current values, not permanent guarantees.

## User-Agent when this service fetches a page

When you submit a URL rather than uploading a file, this service's own
page-rendering step identifies itself as:

```
xtc-converter/1.0 (+https://xtc.hr20k.com/about)
```

If you are fetching the target page yourself for any reason (e.g. to decide
whether it's convertible before submitting), be aware that a site's response
to *your* user agent may differ from its response to this service's.
