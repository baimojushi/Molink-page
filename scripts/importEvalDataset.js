#!/usr/bin/env node
/* Import a directory of room photos once, then freeze an immutable R2 manifest. */
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database');
const r2 = require('../services/r2');
const { EvalDatasetService } = require('../services/evalDatasets');

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
    args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function usage() {
  console.error('Usage: node scripts/importEvalDataset.js --name NAME --rooms-dir DIR --artwork FILE --artwork-width-m 0.8 --artwork-height-m 1.2 [--baseline true]');
}

function imageFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return imageFiles(full);
    return /\.(jpe?g|png|webp)$/i.test(entry.name) ? [full] : [];
  }).sort();
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function uploadImage(file, role, datasetSlug) {
  const hash = fileDigest(file);
  const ext = path.extname(file).toLowerCase() || '.jpg';
  const key = `eval/imports/${datasetSlug}/${role}/${hash}${ext}`;
  await r2.uploadBuffer({
    key,
    body: fs.readFileSync(file),
    contentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  });
  return { key, url: r2.getPublicUrl(key), sha256: hash };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!args.name || !args.roomsDir || !args.artwork || !args.artworkWidthM || !args.artworkHeightM) {
    usage();
    process.exitCode = 2;
    return;
  }
  const roomsRoot = path.resolve(String(args.roomsDir));
  const artworkFile = path.resolve(String(args.artwork));
  const rooms = imageFiles(roomsRoot);
  if (!rooms.length) throw new Error('rooms directory contains no jpg/png/webp images');
  if (!fs.statSync(artworkFile).isFile()) throw new Error('artwork must be a file');
  const datasetSlug = crypto.createHash('sha256').update(String(args.name)).digest('hex').slice(0, 12);
  const artwork = await uploadImage(artworkFile, 'artwork', datasetSlug);
  const items = [];
  for (let index = 0; index < rooms.length; index += 1) {
    const room = await uploadImage(rooms[index], 'rooms', datasetSlug);
    items.push({
      id: `${path.basename(rooms[index], path.extname(rooms[index])).replace(/[^a-zA-Z0-9_-]+/g, '-')}-${String(index + 1).padStart(4, '0')}`,
      room_image_url: room.url,
      artwork_image_url: artwork.url,
      artwork: {
        physical_width_m: Number(args.artworkWidthM),
        physical_height_m: Number(args.artworkHeightM),
        has_frame: String(args.hasFrame || 'true') !== 'false'
      },
      source: {
        room_r2_key: room.key,
        room_sha256: room.sha256,
        artwork_r2_key: artwork.key,
        artwork_sha256: artwork.sha256,
        relative_path: path.relative(roomsRoot, rooms[index])
      },
      rules_overrides: { scene_profile: String(args.sceneProfile || 'home') }
    });
    console.error(`[eval-import] ${index + 1}/${rooms.length} ${rooms[index]}`);
  }
  const service = new EvalDatasetService({ db, r2 });
  const version = await service.freeze({
    name: String(args.name),
    description: String(args.description || ''),
    rights: { source: String(args.rights || 'internal-evaluation') },
    metadata: { baseline: String(args.baseline || 'false') === 'true', imported_by: 'scripts/importEvalDataset.js' },
    items,
    actor: String(args.actor || 'cli')
  });
  process.stdout.write(`${JSON.stringify({ dataset_version: version }, null, 2)}\n`);
}

main().catch(error => {
  console.error(`[eval-import] failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
