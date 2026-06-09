const fs = require('fs');
const path = require('path');
// MOCK createFusionEngine from server.js
const { readFileSync } = fs;

// Just run the same logic to check tracks
const fileContent = fs.readFileSync('c:\\Users\\User\\Documents\\אלי\\CUAS\\new Radar app\\nodejs_backend\\recordings\\recording_2026-06-04_12-22-54.json', 'utf8');
const lines = fileContent.split('\n').filter(Boolean);

let foundTracks = 0;
// We know offlineFusionEngine generated 4897 track updates.
// The real question is: Why did App.tsx not render them?

// Let's look at App.tsx again.
