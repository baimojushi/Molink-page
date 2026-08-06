# Artwork library rebuild notes

## What changed

- Added `artworks` and `artwork_assets` tables in `database.js`
- Added R2 storage adapter in `services/r2.js`
- Added artwork repository in `services/artworks.js`
- Rebuilt client artwork read path to use SQLite instead of `public/artworks/list.json`
- Added admin artwork management APIs in `routes/admin.js`
- Added admin artwork management page at `/admin/artworks`
- Added top-right entry in `public/admin.html`

## Artwork code format

Generated automatically as:

`AW26-000001`

Rules:
- `AW` fixed prefix
- `26` two-digit year
- `000001` six-digit yearly sequence

## R2 environment variables

Required:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Optional defaults already set for your current target:

- `R2_ACCOUNT_ID=2cae7e0d09899585fac8567d9d054572`
- `R2_BUCKET=artworks`
- `R2_ENDPOINT=https://2cae7e0d09899585fac8567d9d054572.r2.cloudflarestorage.com`
- `R2_PUBLIC_BASE_URL=https://pub-b2df17496aee418db2c3c6737e72bc8b.r2.dev`

## New admin APIs

- `GET /api/admin/artworks`
- `GET /api/admin/artworks/:id`
- `POST /api/admin/artworks`
- `PATCH /api/admin/artworks/:id`
- `DELETE /api/admin/artworks/:id`
- `POST /api/admin/artworks/:id/assets/artwork`
- `POST /api/admin/artworks/:id/assets/effect`
- `PATCH /api/admin/artworks/:id/cover`
- `DELETE /api/admin/artwork-assets/:assetId`
- `GET /api/admin/artworks-sql/schema`
- `POST /api/admin/artworks-sql/query`
- `GET /api/admin/artworks/r2-status`

## Client paths rebuilt to use DB

- `GET /api/client/artworks`
- `GET /api/client/artworks/resolve`
- recommend chain inside `routes/client.js`
- submit fallback chain inside `routes/client.js`

## Notes

- Static `public/artworks/list.json` is no longer used by the rebuilt client route.
- Miniapp code was intentionally left untouched.
- Existing AI service files were kept intact. The rebuild changes the upstream artwork data source and keeps image URLs in the same `file_url`-based format expected by the current Snaptoshine and Qwen flow.
