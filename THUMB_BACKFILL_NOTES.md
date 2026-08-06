# Artwork Thumbnail Backfill

This repository now stores dedicated artwork thumbnails in R2 for recommendation-list rendering.

## One-time backfill for existing assets

Run on the server after deployment:

```bash
npm run artworks:backfill-thumbs
```

Optional flags:

```bash
node scripts/backfillArtworkThumbnails.js --limit=500
node scripts/backfillArtworkThumbnails.js --artwork-id=<artwork-id>
node scripts/backfillArtworkThumbnails.js --start-after-id=<asset-id>
node scripts/backfillArtworkThumbnails.js --dry-run
```

## Behavior

- New uploads generate thumbnails immediately.
- Existing assets without `thumb_url` are backfilled by the script.
- Before backfill finishes, the admin recommendation list falls back to `/api/client/thumb` so old assets still load as thumbnails instead of full-size originals.
